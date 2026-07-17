import {
  type SweepExecutePayload,
  type SweepLegReport,
  type SweepReceipt,
  sweepExecutePayloadSchema,
} from "@retenix/shared";
import {
  SUPPORTED_TOKEN_TYPE,
  createSellTransaction,
  createUa,
  magicSigner,
  parseFeeTotals,
  pollToTerminal,
  signAndSend,
  type ITradeConfig,
  type MagicSignerClient,
  type UniversalAccount,
} from "@retenix/ua";
import { clientEnv } from "@/env";
import { magic } from "@/lib/magic";
import { signEnvelope } from "@/lib/sign";
import { trpcVanilla } from "@/lib/trpc-vanilla";

/*
 * The sweep leg-runner — the browser half of the "one confirmation, N headless
 * signatures" pattern (doc 06 §Signature semantics; docs 13/15 reuse this).
 *
 * The user's ONE visible act is the ConfirmSheet tap that calls runSweep().
 * Everything below is headless: the two sweep.execute envelopes and every
 * per-leg rootHash are plain personal_sign through Magic's invisible iframe
 * (G5) — no popups, no further UI. Legs run here and not on the server
 * because (a) the user's key exists only in this Magic session and (b) quotes
 * expire — create → sign → send must be one continuous flow per leg.
 *
 * The leg loop is STRICTLY SEQUENTIAL by design: first-use 7702 authorizations
 * call magic.evm.switchChain, which is global mutable state on the Magic
 * provider — parallel legs would race it (and the loop is also what keeps
 * each quote inside its signing window).
 */

/** Sells settle ONLY into USDC in the user's own UA (doc 06 hard constraint). */
const SELL_TO_USDC: ITradeConfig = {
  usePrimaryTokens: [SUPPORTED_TOKEN_TYPE.USDC],
};

/** Client-side settlement polling — the server re-verifies with its own poll. */
const SETTLE_POLL = { intervalMs: 2000, timeoutMs: 120_000 };

const REPORT_ATTEMPTS = 3;
const REPORT_BACKOFF_MS = [1_000, 3_000];

/** sessionStorage key for a report that has not reached the server yet. */
const PENDING_KEY = "retenix:sweep-pending";

export type SweepProgress =
  | { stage: "authorizing" }
  | { stage: "executing"; done: number; total: number }
  | { stage: "settling" }
  | { stage: "reporting" };

export type SweepRunResult =
  | { kind: "receipt"; receipt: SweepReceipt }
  | { kind: "nothing" };

function browserUa(eoa: string): UniversalAccount {
  // Same construction as lib/post-login.ts — browser creds, owner = the EOA.
  return createUa({
    ownerAddress: eoa,
    credentials: {
      projectId: clientEnv.NEXT_PUBLIC_PARTICLE_PROJECT_ID,
      projectClientKey: clientEnv.NEXT_PUBLIC_PARTICLE_CLIENT_KEY,
      projectAppUuid: clientEnv.NEXT_PUBLIC_PARTICLE_APP_UUID,
    },
  });
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

// Private mode may make sessionStorage throw — a lost stash only loses the
// crash-resume convenience, never the sweep itself (lib/gate.ts pattern).
function stashPending(executionId: string, legs: SweepLegReport[]): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ executionId, legs }));
  } catch {
    /* best effort */
  }
}

function clearPending(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* best effort */
  }
}

function readPending(): { executionId: string; legs: SweepLegReport[] } | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    const report = sweepExecutePayloadSchema.safeParse({
      phase: "report",
      ...(parsed as object),
    });
    return report.success && report.data.phase === "report"
      ? { executionId: report.data.executionId, legs: report.data.legs }
      : null;
  } catch {
    return null;
  }
}

async function signedExecute(eoa: string, payload: SweepExecutePayload) {
  // A FRESH envelope per call — nonces are single-use, so a retry must re-sign
  // (headless), never replay bytes.
  const envelope = await signEnvelope("sweep.execute", payload, eoa);
  return trpcVanilla.sweep.execute.mutate(envelope);
}

async function reportWithRetry(
  eoa: string,
  executionId: string,
  legs: SweepLegReport[],
): Promise<SweepReceipt> {
  let lastError: unknown;
  for (let attempt = 0; attempt < REPORT_ATTEMPTS; attempt++) {
    try {
      const res = await signedExecute(eoa, { phase: "report", executionId, legs });
      if (res.phase !== "report") throw new Error("unexpected execute response");
      return res.receipt;
    } catch (err) {
      lastError = err;
      const code = (err as { data?: { code?: string } }).data?.code;
      // Permanent rejections don't heal by retrying.
      if (code === "BAD_REQUEST" || code === "FORBIDDEN" || code === "UNAUTHORIZED") {
        throw err;
      }
      const backoff = REPORT_BACKOFF_MS[attempt];
      if (backoff) await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastError;
}

/**
 * If a previous session executed legs but never delivered the report (tab
 * closed mid-flight), deliver it now so the receipt is not lost. Returns the
 * receipt when a pending report existed and landed.
 */
export async function resumePendingReport(eoa: string): Promise<SweepReceipt | null> {
  const pending = readPending();
  if (!pending) return null;
  const receipt = await reportWithRetry(eoa, pending.executionId, pending.legs);
  clearPending();
  return receipt;
}

/**
 * The whole sweep, from the single confirmation: authorize (server re-derives
 * the item list) → sequential headless legs → settle → report → THE receipt.
 * Per-leg failures are recorded and the loop continues (continue-and-report);
 * this function throws only when the sweep as a whole could not run.
 */
export async function runSweep(
  eoa: string,
  onProgress?: (p: SweepProgress) => void,
): Promise<SweepRunResult> {
  onProgress?.({ stage: "authorizing" });
  const authRes = await signedExecute(eoa, { phase: "authorize" });
  if (authRes.phase !== "authorize") throw new Error("unexpected execute response");
  const { executionId, items } = authRes.authorization;
  if (!executionId || items.length === 0) return { kind: "nothing" };

  const ua = browserUa(eoa);
  // MagicSignerClient is @retenix/ua's structural contract for the Magic
  // surface it touches (switchChain / sign7702Authorization / personal_sign).
  // Magic's own typings wrap request() in a PromiEvent, which is a Promise at
  // runtime — the cast bridges the nominal gap, not a behavioral one.
  const signer = magicSigner(magic as unknown as MagicSignerClient, eoa);

  const legs: SweepLegReport[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    onProgress?.({ stage: "executing", done: i, total: items.length });
    try {
      // create → sign → send in ONE continuous flow; the quote never waits.
      const tx = await createSellTransaction(
        ua,
        { token: { chainId: item.chainId, address: item.token }, amount: item.amountHuman },
        SELL_TO_USDC,
      );
      const feesQuoted = parseFeeTotals(tx);
      const { transactionId } = await signAndSend(ua, tx, signer);
      legs.push({
        chainId: item.chainId,
        token: item.token,
        transactionId,
        clientOutcome: "finished", // refined below once it settles
        feesQuoted,
      });
    } catch (err) {
      legs.push({
        chainId: item.chainId,
        token: item.token,
        clientOutcome: "failed",
        error: errorMessage(err),
      });
    }
  }
  stashPending(executionId, legs);

  onProgress?.({ stage: "settling" });
  await Promise.all(
    legs.map(async (leg) => {
      if (!leg.transactionId) return;
      try {
        const settled = await pollToTerminal(ua, leg.transactionId, SETTLE_POLL);
        leg.clientOutcome =
          settled.outcome === "finished"
            ? "finished"
            : settled.outcome === "refunded"
              ? "refunded"
              : "timeout";
      } catch {
        leg.clientOutcome = "timeout"; // the server's own poll is authoritative
      }
    }),
  );
  stashPending(executionId, legs);

  onProgress?.({ stage: "reporting" });
  const receipt = await reportWithRetry(eoa, executionId, legs);
  clearPending();
  // doc 14: this session transacted — every send bumped a nonce somewhere,
  // voiding any escrowed inheritance tuples. Restore coverage silently.
  void import("@/lib/escrow").then((m) => m.scheduleTupleRefresh()).catch(() => {});
  return { kind: "receipt", receipt };
}
