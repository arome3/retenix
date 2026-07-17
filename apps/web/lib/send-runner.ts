import {
  createTransferTransaction,
  createUa,
  magicSigner,
  parseFeeTotals,
  pollToTerminal,
  signAndSend,
  type FeeTotalsUSD,
  type MagicSignerClient,
  type UniversalAccount,
} from "@retenix/ua";
import type { SendAuthorizedTarget, SendToKind } from "@retenix/shared";
import { clientEnv } from "@/env";
import { magic } from "@/lib/magic";
import { signEnvelope } from "@/lib/sign";
import { trpcVanilla } from "@/lib/trpc-vanilla";

/*
 * The send/withdraw runner (doc 15) — a single-leg cousin of
 * lib/sell-runner.ts with the sweep's two-phase envelope discipline. The
 * user's ONE visible act is the ConfirmSheet tap; everything else is
 * headless personal_sign (G5): the signed AUTHORIZE envelope (the server
 * resolves + pins the target), the UA root hash, and the signed REPORT
 * envelope. The transfer is created against the AUTHORIZED target only —
 * never client-derived values (the email→address mapping lives server-side).
 *
 * Quotes expire (doc 03): the pre-confirm quote is ADVISORY (the C6 `~`),
 * discarded unsigned; the real transfer is created fresh after authorize.
 */

/** Client-side settlement polling; the server re-verifies with its own poll. */
const SETTLE_POLL = { intervalMs: 2000, timeoutMs: 120_000 };

const REPORT_ATTEMPTS = 4;
const REPORT_BACKOFF_MS = [1_500, 3_000, 6_000];

/** sessionStorage stash so a closed tab can't lose the receipt (sweep's
 *  resumePendingReport posture). */
const PENDING_KEY = "retenix:send-pending";

export interface SendInput {
  to: { kind: SendToKind; value: string };
  amountUsd: number;
  /** Withdraw only — both together (the server enforces the pairing). */
  asset?: string;
  chainId?: number;
  senderEmail?: string;
}

export type SendProgress =
  | { stage: "authorizing" }
  | { stage: "signing" }
  | { stage: "settling"; transactionId: string }
  | { stage: "reporting" };

export type SendRunResult =
  | { kind: "invited"; message: string }
  | { kind: "sent"; receipt: string; outcome: string }
  | { kind: "settling"; message: string }
  | { kind: "failed"; message: string };

function browserUa(eoa: string): UniversalAccount {
  return createUa({
    ownerAddress: eoa,
    credentials: {
      projectId: clientEnv.NEXT_PUBLIC_PARTICLE_PROJECT_ID,
      projectClientKey: clientEnv.NEXT_PUBLIC_PARTICLE_CLIENT_KEY,
      projectAppUuid: clientEnv.NEXT_PUBLIC_PARTICLE_APP_UUID,
    },
  });
}

/**
 * Advisory fee preview for the ConfirmSheet (`~` fees — discarded, never
 * signed). Email recipients' addresses are deliberately not exposed by
 * send.resolve, so email sends quote with the sender's own address standing
 * in as receiver: UA transfer fees are routing costs for (token, chain,
 * amount) and do not depend on who receives.
 */
export async function quoteSendFees(
  eoa: string,
  quote: {
    token: { chainId: number; address: string };
    amountUnits: string;
    receiver?: string;
  },
): Promise<FeeTotalsUSD> {
  const tx = await createTransferTransaction(browserUa(eoa), {
    token: quote.token,
    amount: quote.amountUnits,
    receiver: quote.receiver ?? eoa,
  });
  return parseFeeTotals(tx);
}

interface PendingReport {
  eoa: string;
  executionId: string;
  transactionId?: string;
  clientOutcome: "finished" | "refunded" | "failed" | "timeout";
  feesQuoted?: FeeTotalsUSD;
}

function stashPending(p: PendingReport): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    // private mode — the report retry loop is the only safety net then
  }
}

function clearPending(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // ignore
  }
}

function readPending(eoa: string): PendingReport | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingReport;
    return p.eoa?.toLowerCase() === eoa.toLowerCase() ? p : null;
  } catch {
    return null;
  }
}

/** Signed report with retries — a FRESH envelope per attempt (nonces are
 *  single-use); CONFLICT "still settling" retries after backoff. */
async function reportWithRetry(
  eoa: string,
  pending: PendingReport,
): Promise<SendRunResult> {
  let lastError = "the send report didn't reach the server";
  for (let attempt = 0; attempt < REPORT_ATTEMPTS; attempt += 1) {
    try {
      const payload = {
        phase: "report" as const,
        executionId: pending.executionId,
        ...(pending.transactionId ? { transactionId: pending.transactionId } : {}),
        clientOutcome: pending.clientOutcome,
        ...(pending.feesQuoted ? { feesQuoted: pending.feesQuoted } : {}),
      };
      const envelope = await signEnvelope("send.execute", payload, eoa);
      const res = await trpcVanilla.send.execute.mutate(envelope);
      if (res.phase === "report") {
        clearPending();
        return {
          kind: "sent",
          receipt: res.receipt.receipt,
          outcome: res.receipt.outcome,
        };
      }
      lastError = "unexpected server response";
    } catch (err) {
      lastError = errorMessage(err);
    }
    const backoff = REPORT_BACKOFF_MS[attempt];
    if (backoff !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  // The stash survives — resumePendingSendReport picks it up next visit.
  return { kind: "settling", message: lastError };
}

/** Deliver a stashed report after a crash/close — call on /send mount. */
export async function resumePendingSendReport(
  eoa: string,
): Promise<SendRunResult | null> {
  const pending = readPending(eoa);
  if (!pending) return null;
  return reportWithRetry(eoa, pending);
}

/** The whole send from one confirmation: signed authorize → transfer against
 *  the PINNED target → settle → signed report. */
export async function runSend(
  eoa: string,
  input: SendInput,
  onProgress?: (p: SendProgress) => void,
): Promise<SendRunResult> {
  onProgress?.({ stage: "authorizing" });

  let target: SendAuthorizedTarget;
  let executionId: string;
  try {
    const payload = {
      phase: "authorize" as const,
      to: input.to,
      amountUsd: input.amountUsd,
      ...(input.asset !== undefined ? { asset: input.asset } : {}),
      ...(input.chainId !== undefined ? { chainId: input.chainId } : {}),
      ...(input.senderEmail ? { senderEmail: input.senderEmail } : {}),
    };
    const envelope = await signEnvelope("send.execute", payload, eoa);
    const res = await trpcVanilla.send.execute.mutate(envelope);
    if (res.phase !== "authorize") {
      return { kind: "failed", message: "unexpected server response" };
    }
    if (res.authorization.invited) {
      return { kind: "invited", message: res.authorization.message };
    }
    ({ executionId, target } = res.authorization);
  } catch (err) {
    return { kind: "failed", message: errorMessage(err) };
  }

  // Create → sign → send, one continuous flow against the authorized target.
  onProgress?.({ stage: "signing" });
  const ua = browserUa(eoa);
  const signer = magicSigner(magic as unknown as MagicSignerClient, eoa);
  let transactionId: string | undefined;
  let feesQuoted: FeeTotalsUSD | undefined;
  try {
    const tx = await createTransferTransaction(ua, {
      token: { chainId: target.token.chainId, address: target.token.address },
      amount: target.amountUnits,
      receiver: target.address,
    });
    try {
      feesQuoted = parseFeeTotals(tx);
    } catch {
      feesQuoted = undefined;
    }
    ({ transactionId } = await signAndSend(ua, tx, signer));
  } catch (err) {
    // Nothing (or nothing verifiable) was sent — report the failure so the
    // authorization is receipted and the double-tap guard releases.
    stashPending({ eoa, executionId, clientOutcome: "failed" });
    const reported = await reportWithRetry(eoa, {
      eoa,
      executionId,
      clientOutcome: "failed",
    });
    return reported.kind === "sent"
      ? { kind: "failed", message: errorMessage(err) }
      : reported;
  }

  onProgress?.({ stage: "settling", transactionId });
  let clientOutcome: PendingReport["clientOutcome"] = "timeout";
  try {
    const settled = await pollToTerminal(ua, transactionId, SETTLE_POLL);
    clientOutcome = settled.outcome;
  } catch {
    clientOutcome = "timeout"; // the server's own poll decides
  }

  const pending: PendingReport = {
    eoa,
    executionId,
    transactionId,
    clientOutcome,
    ...(feesQuoted ? { feesQuoted } : {}),
  };
  stashPending(pending);
  onProgress?.({ stage: "reporting" });
  return reportWithRetry(eoa, pending);
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
