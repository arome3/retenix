// packages/ua/src/lifecycle.ts — transaction-status lifecycle (doc 03).
//
// Poll getTransaction(id) against UA_TRANSACTION_STATUS
// (INITIALIZING=0 … FINISHED=7, REFUND_* 8–11, PENNY_* 12–14). The three terminal
// buckets this cares about:
//   FINISHED (7)            → the money moved.
//   REFUND_* (8–11)         → failed-with-refund. These are successes OF THE SAFETY
//                             SYSTEM: funds returned. Receipt them honestly downstream
//                             ("Didn't complete — your $X was returned"); NEVER map a
//                             refund to success or to plain failure.
//   neither, past timeout   → give up and report; the tx may still settle later.
//
// The raw `t` payload is returned untouched on every outcome so callers can bubble
// per-op status into executions.quote_json for partial-failure forensics (doc 03
// security requirement).
import type { UniversalAccount } from "@particle-network/universal-account-sdk";

/** Raw getTransaction payload. `status` is a UA_TRANSACTION_STATUS number; the rest
 *  is opaque and preserved verbatim for forensics. */
export interface UaTransaction {
  status: number;
  [key: string]: unknown;
}

export const TERMINAL = { FINISHED: 7, REFUND_MIN: 8, REFUND_MAX: 11 } as const;

export type PollOutcome = "finished" | "refunded" | "timeout";
export interface PollResult {
  outcome: PollOutcome;
  t: UaTransaction;
}

/** Minimal surface pollToTerminal needs. The real UniversalAccount satisfies it;
 *  unit tests inject a mock getTransaction. */
export type TransactionSource = Pick<UniversalAccount, "getTransaction">;

export async function pollToTerminal(
  ua: TransactionSource,
  id: string,
  {
    intervalMs = 2000,
    timeoutMs = 180_000,
  }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<PollResult> {
  const start = Date.now();
  for (;;) {
    const t = (await ua.getTransaction(id)) as UaTransaction;
    if (t.status === TERMINAL.FINISHED) return { outcome: "finished", t };
    if (t.status >= TERMINAL.REFUND_MIN && t.status <= TERMINAL.REFUND_MAX)
      return { outcome: "refunded", t };
    if (Date.now() - start > timeoutMs) return { outcome: "timeout", t };
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
