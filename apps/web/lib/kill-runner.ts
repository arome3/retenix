import {
  SUPPORTED_TOKEN_TYPE,
  createConvertTransaction,
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
import type { FeeTotals, KillWorkItem } from "@retenix/shared";
import { clientEnv } from "@/env";
import { magic } from "@/lib/magic";
import { personalSign, signEnvelope } from "@/lib/sign";
import { trpcVanilla } from "@/lib/trpc-vanilla";

/*
 * The kill leg-runner (doc 13) — the browser half of the doc-06 pattern,
 * adapted for the <10 s AC1 budget. The user's ONE visible act is the 1.5 s
 * hold; everything here is headless: the revokeAll digest, the kill.execute
 * envelope, and every leg rootHash are plain personal_sign through Magic's
 * invisible iframe (G5).
 *
 * Pipeline shape (differs from the sweep's strictly-sequential loop, and
 * why): quote CREATION runs in a pool of 2 — it is the slow step (~1–3 s) and
 * has no Magic surface, so overlapping it is safe; SIGN+SEND serializes
 * through a mutex because first-use 7702 authorizations call
 * magic.evm.switchChain, global mutable state on the Magic provider (module
 * 06's binding constraint). Pool width 2 also bounds quote staleness: a
 * created quote waits at most ~one sign+send cycle (~1 s), far inside its
 * signing window. A fully sequential loop (quote+sign+send × 5) would blow
 * the AC1 budget; fully parallel signing would race switchChain.
 *
 * The AC1 clock stops when every leg's sendTransaction has returned an id —
 * submitted-claims to the server are fire-and-forget with retry, never on the
 * critical path. Settlement follows in the background (pollToTerminal), each
 * leg reporting a terminal claim the server re-verifies.
 *
 * Crash resilience is SERVER-side (doc 13: legs are DB rows): re-opening
 * /kill resumes via kill.prepare → the idempotent kill.execute, which returns
 * pending legs to run and submitted legs to keep polling. No sessionStorage
 * report stash is needed — per-leg reports land as they happen.
 */

const SELL_TO_USDC: ITradeConfig = {
  usePrimaryTokens: [SUPPORTED_TOKEN_TYPE.USDC],
};

/** Quote-creation pool width == max un-signed quotes in existence. */
const CREATE_POOL = 2;

/** Client-side settlement polling — the server re-verifies with its own poll. */
const SETTLE_POLL = { intervalMs: 2000, timeoutMs: 120_000 };

/** "still settling" CONFLICTs re-poll this many times before giving up (the
 *  leg stays `submitted`; a later visit or retry chip picks it up). */
const TERMINAL_REPORT_ATTEMPTS = 10;
const TERMINAL_REPORT_WAIT_MS = 2_000;

const SUBMIT_REPORT_ATTEMPTS = 3;
const SUBMIT_REPORT_BACKOFF_MS = [1_000, 3_000];

export type KillProgress =
  | { stage: "preparing" }
  | { stage: "revoking" }
  | { stage: "executing"; submitted: number; failed: number; total: number }
  | { stage: "settling" }
  | { stage: "done" };

export interface KillRunResult {
  killId: string;
  revoke: { state: string; txHash?: string };
  /** Legs whose sendTransaction returned an id. */
  submitted: number;
  /** Legs that failed before a send (already reported failed). */
  failed: number;
  total: number;
  /** Client-clock tap → last sendTransaction return (AC1's own measure;
   *  the server's marks are the recorded truth). */
  tapToLastSubmitMs: number | null;
}

export function browserUa(eoa: string): UniversalAccount {
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

/** Serialize an async section — the sign+send mutex (switchChain constraint). */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** A fixed-width worker pool over `items`, preserving per-item isolation. */
export async function runPool<T>(
  items: readonly T[],
  width: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(width, items.length)) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await worker(items[i], i);
      }
    },
  );
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Server calls
// ---------------------------------------------------------------------------

type ExecuteResponse = Awaited<ReturnType<typeof trpcVanilla.kill.execute.mutate>>;

async function signedExecute(
  eoa: string,
  payload: { revokeAllAuth?: { nonce: string; signature: string }; tapAtMs?: number; holdCompletedAtMs?: number },
): Promise<ExecuteResponse> {
  // A FRESH envelope per call — nonces are single-use (headless re-sign).
  const envelope = await signEnvelope("kill.execute", payload, eoa);
  return trpcVanilla.kill.execute.mutate(envelope);
}

/** Fire-and-forget with bounded retry — never on the AC1 critical path. */
async function reportSubmitted(
  killId: string,
  legId: string,
  transactionId: string,
  feesQuoted?: FeeTotals,
): Promise<void> {
  for (let attempt = 0; attempt < SUBMIT_REPORT_ATTEMPTS; attempt++) {
    try {
      await trpcVanilla.kill.reportLeg.mutate({
        killId,
        legId,
        phase: "submitted",
        transactionId,
        feesQuoted,
      });
      return;
    } catch {
      const backoff = SUBMIT_REPORT_BACKOFF_MS[attempt];
      if (backoff) await new Promise((r) => setTimeout(r, backoff));
    }
  }
  // Undelivered submitted-claims are healed by the terminal report (it
  // carries the transactionId) or by the resume path — never lost silently.
}

async function reportFailed(killId: string, legId: string, error: string): Promise<void> {
  try {
    await trpcVanilla.kill.reportLeg.mutate({ killId, legId, phase: "failed", error });
  } catch {
    // The leg stays pending server-side; resume re-arms it. Never throws into
    // the leg loop — continue-and-report.
  }
}

/** Terminal claim with a "still settling" re-poll loop. */
async function reportTerminal(
  killId: string,
  legId: string,
  transactionId: string,
  clientOutcome: "finished" | "refunded" | "timeout",
  feesQuoted?: FeeTotals,
): Promise<void> {
  for (let attempt = 0; attempt < TERMINAL_REPORT_ATTEMPTS; attempt++) {
    try {
      await trpcVanilla.kill.reportLeg.mutate({
        killId,
        legId,
        phase: "terminal",
        transactionId,
        clientOutcome,
        feesQuoted,
      });
      return;
    } catch (err) {
      const code = (err as { data?: { code?: string } }).data?.code;
      if (code === "CONFLICT") {
        // Server says still settling — wait and re-claim.
        await new Promise((r) => setTimeout(r, TERMINAL_REPORT_WAIT_MS));
        continue;
      }
      if (code === "BAD_REQUEST" || code === "NOT_FOUND") throw err;
      await new Promise((r) => setTimeout(r, TERMINAL_REPORT_WAIT_MS));
    }
  }
  // Bounded give-up: the leg stays submitted; kill.status keeps showing the
  // honest in-flight state and a later visit resumes the poll.
}

// ---------------------------------------------------------------------------
// Leg execution
// ---------------------------------------------------------------------------

interface LegSend {
  legId: string;
  transactionId?: string;
  feesQuoted?: FeeTotals;
  submittedAtMs?: number;
}

/** create → sign → send ONE leg (one continuous flow; the quote never waits
 *  longer than the mutex queue). Failures are reported, never thrown. */
async function executeLeg(
  ua: UniversalAccount,
  signer: ReturnType<typeof magicSigner>,
  locked: <T>(fn: () => Promise<T>) => Promise<T>,
  killId: string,
  item: KillWorkItem,
): Promise<LegSend> {
  try {
    const tx =
      item.kind === "sell"
        ? await createSellTransaction(
            ua,
            {
              token: { chainId: item.chainId, address: item.token ?? "" },
              amount: item.amountHuman ?? "",
            },
            SELL_TO_USDC,
          )
        : await createConvertTransaction(
            ua,
            {
              chainId: item.chainId,
              expectToken: {
                type: SUPPORTED_TOKEN_TYPE.USDC,
                amount: (item.expectUsdc ?? 0).toFixed(2),
              },
            },
            { usePrimaryTokens: [item.primaryType as SUPPORTED_TOKEN_TYPE] },
          );
    const feesQuoted = parseFeeTotals(tx);
    const { transactionId } = await locked(() => signAndSend(ua, tx, signer));
    const submittedAtMs = Date.now();
    void reportSubmitted(killId, item.legId, transactionId, feesQuoted);
    return { legId: item.legId, transactionId, feesQuoted, submittedAtMs };
  } catch (err) {
    await reportFailed(killId, item.legId, errorMessage(err));
    return { legId: item.legId };
  }
}

/** Poll one sent leg to terminal and deliver the claim. */
async function settleLeg(
  ua: UniversalAccount,
  killId: string,
  legId: string,
  transactionId: string,
  feesQuoted?: FeeTotals,
): Promise<void> {
  let clientOutcome: "finished" | "refunded" | "timeout";
  try {
    const settled = await pollToTerminal(ua, transactionId, SETTLE_POLL);
    clientOutcome =
      settled.outcome === "finished"
        ? "finished"
        : settled.outcome === "refunded"
          ? "refunded"
          : "timeout";
  } catch {
    clientOutcome = "timeout"; // the server's own poll is authoritative
  }
  await reportTerminal(killId, legId, transactionId, clientOutcome, feesQuoted);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface KillMarks {
  tapAtMs?: number;
  holdCompletedAtMs?: number;
}

/**
 * The whole kill, from the completed hold: prepare → headless revokeAll
 * digest sign → kill.execute (revokes FIRST server-side) → leg pipeline →
 * background settlement. Resolves when every leg is submitted-or-failed (the
 * AC1 boundary); settlement reporting continues after resolution.
 */
export async function runKill(
  eoa: string,
  marks: KillMarks,
  onProgress?: (p: KillProgress) => void,
): Promise<KillRunResult> {
  onProgress?.({ stage: "preparing" });
  let prep = await trpcVanilla.kill.prepare.query();

  onProgress?.({ stage: "revoking" });
  let res: ExecuteResponse | null = null;
  for (let attempt = 0; attempt < 2 && !res; attempt++) {
    const revokeAllAuth =
      prep.needsRevoke && prep.digest && prep.nonce
        ? { nonce: prep.nonce, signature: await personalSign(prep.digest, eoa) }
        : undefined;
    try {
      res = await signedExecute(eoa, { revokeAllAuth, ...marks });
    } catch (err) {
      // A raced authNonce (another relayed op landed between prepare and
      // execute) heals with ONE fresh prepare + re-sign, still headless.
      const message = (err as Error).message ?? "";
      if (attempt === 0 && message.includes("re-prepare")) {
        prep = await trpcVanilla.kill.prepare.query();
        continue;
      }
      throw err;
    }
  }
  if (!res) throw new Error("kill.execute did not start");

  const { killId, workItems, polling } = res;
  const total = workItems.length + polling.length;
  const ua = browserUa(eoa);
  const signer = magicSigner(magic as unknown as MagicSignerClient, eoa);
  const locked = createMutex();

  let submitted = 0;
  let failed = 0;
  const sends: LegSend[] = [];
  onProgress?.({ stage: "executing", submitted, failed, total });

  let lastSubmitAtMs: number | null = null;
  await runPool(workItems, CREATE_POOL, async (item) => {
    const send = await executeLeg(ua, signer, locked, killId, item);
    sends.push(send);
    if (send.transactionId) {
      submitted += 1;
      lastSubmitAtMs = send.submittedAtMs ?? Date.now();
    } else {
      failed += 1;
    }
    onProgress?.({ stage: "executing", submitted, failed, total });
  });

  // AC1 boundary: every leg submitted (or honestly failed). Settlement runs
  // in the background — per-leg claims land as each poll terminates.
  onProgress?.({ stage: "settling" });
  const settlements = [
    ...sends
      .filter((s): s is Required<Pick<LegSend, "legId" | "transactionId">> & LegSend =>
        Boolean(s.transactionId),
      )
      .map((s) => settleLeg(ua, killId, s.legId, s.transactionId, s.feesQuoted)),
    ...polling.map((p) => settleLeg(ua, killId, p.legId, p.transactionId)),
  ];
  void Promise.allSettled(settlements).then(() => onProgress?.({ stage: "done" }));

  // doc 14: this session transacted — sends bump nonces, voiding any escrowed
  // inheritance tuples. Restore coverage silently once settlement is rolling.
  void import("@/lib/escrow").then((m) => m.scheduleTupleRefresh()).catch(() => {});

  return {
    killId,
    revoke: { state: res.revoke.state, txHash: res.revoke.txHash },
    submitted,
    failed,
    total,
    tapToLastSubmitMs:
      marks.tapAtMs !== undefined && lastSubmitAtMs !== null
        ? lastSubmitAtMs - marks.tapAtMs
        : null,
  };
}

/**
 * Resume an interrupted kill (crash resilience, doc 13): the idempotent
 * kill.execute converges on the active kill — pending legs are re-run,
 * submitted legs resume polling. Returns null when nothing is active.
 */
export async function resumeKill(
  eoa: string,
  onProgress?: (p: KillProgress) => void,
): Promise<KillRunResult | null> {
  const prep = await trpcVanilla.kill.prepare.query();
  if (!prep.activeKillId) return null;
  return runKill(eoa, {}, onProgress);
}

/**
 * Retry one leg from its chip (PS-F6-AC2): kill.retryLeg re-arms it
 * server-side (a signed envelope — headless), then the leg runs and settles
 * exactly like a first attempt. Retryable forever without re-arming the hold.
 */
export async function retryKillLeg(
  eoa: string,
  killId: string,
  legId: string,
): Promise<void> {
  const payload = { killId, legId };
  const envelope = await signEnvelope("kill.retryLeg", payload, eoa);
  const { workItem } = await trpcVanilla.kill.retryLeg.mutate(envelope);

  const ua = browserUa(eoa);
  const signer = magicSigner(magic as unknown as MagicSignerClient, eoa);
  const send = await executeLeg(ua, signer, createMutex(), killId, workItem);
  if (send.transactionId) {
    await settleLeg(ua, killId, legId, send.transactionId, send.feesQuoted);
  }
}
