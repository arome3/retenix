/*
 * Kill-switch contract (doc 13, C7 "Liquidate & Lock") — event types, the
 * PROPOSED constants, leg/receipt payload shapes, and the wire schemas for
 * kill.execute / kill.reportLeg / kill.retryLeg.
 *
 * Client (KillSwitch → lib/kill-runner.ts) and server (routers/kill.ts) both
 * import these, so the signed payload the browser personal_signs can never
 * drift from what the server validates (the signing.ts/sweep.ts discipline).
 * Framework-free on purpose.
 *
 * The kill.leg event payload serves THREE consumers at once — keep all three
 * contracts in mind when touching it:
 *   1. the feed (packages/shared/src/feed.ts): `receipt` is set ONLY at a
 *      terminal state, so in-flight legs never render as receipts;
 *   2. the portfolio basis ledger (portfolio-fills.ts SELL_FILL_EVENT_TYPES):
 *      `outcome` MUST be present from birth ("pending") — sellFillFromEvent
 *      treats an ABSENT outcome as completed, and a completed sell without an
 *      `assetId` poisons every basis as unattributed;
 *   3. kill.status reconstruction (crash resilience: the rows are the truth).
 */
import { z } from "zod";
import { feeTotalsSchema, type FeeTotals } from "./sweep";

// ---------------------------------------------------------------------------
// Event types (events.type strings — the doc 13 set)
// ---------------------------------------------------------------------------

export const KILL_EVENTS = {
  /** One per kill: marks, revoke state, skips. Audit row, never a feed row. */
  started: "kill.started",
  /** One per liquidation leg; payload updated in place through transitions. */
  leg: "kill.leg",
  /** THE aggregate receipt — exactly one per kill (PS-F6-AC2). */
  receipt: "kill.receipt",
} as const;

// ---------------------------------------------------------------------------
// Constants (PROPOSED where noted — change HERE only, doc 06 convention)
// ---------------------------------------------------------------------------

/** Press-and-hold arm duration — C7 verbatim (1.5 s). */
export const KILL_HOLD_MS = 1_500;

/** PROPOSED: converts are output-denominated (IConvertTransaction expects a
 *  USDC amount), so the expect amount is the primary's USD value with this
 *  haircut — without it the quote fails on fees. Residual dust is the dust
 *  sweeper's domain (doc 06), honestly documented. */
export const KILL_CONVERT_HAIRCUT = 0.98;

/** PROPOSED: primaries worth less than this are skipped (listed on the
 *  completion screen), not converted — a sub-$0.50 convert loses to fees. */
export const KILL_CONVERT_FLOOR_USD = 0.5;

// ---------------------------------------------------------------------------
// Leg state machine (doc 13: pending/submitted/settled/failed/refunded; the
// sweep precedent adds "unverified" for claims the server could not confirm)
// ---------------------------------------------------------------------------

export const KILL_LEG_STATES = [
  "pending", // planned; nothing sent (also the post-retry re-arm state)
  "submitted", // sendTransaction returned an id — the AC1 clock stops here
  "settled", // server-verified FINISHED (counts as a sell fill — sellCompleted)
  "failed", // quote/sign/send failed, or the tx provably wasn't this leg
  "refunded", // UA REFUND (8–11): money came back, position still held
  "unverified", // client claimed success; server could not confirm the detail
] as const;
export type KillLegState = (typeof KILL_LEG_STATES)[number];

/** States that end a leg. pending/submitted are the only in-flight states. */
export const KILL_TERMINAL_STATES = [
  "settled",
  "failed",
  "refunded",
  "unverified",
] as const satisfies readonly KillLegState[];

export const isKillTerminal = (s: KillLegState): boolean =>
  (KILL_TERMINAL_STATES as readonly string[]).includes(s);

/** States kill.retryLeg may re-arm: the position is still (or again) held.
 *  "submitted" is retryable ONLY after the server's own poll says the tx
 *  terminally failed — never blindly (the tx may still land). */
export const KILL_RETRYABLE_STATES = [
  "failed",
  "refunded",
  "unverified",
] as const satisfies readonly KillLegState[];

export type KillLegKind = "sell" | "convert";

// ---------------------------------------------------------------------------
// Why something was NOT planned as a leg (completion screen lists these)
// ---------------------------------------------------------------------------

export const KILL_SKIP_REASONS = [
  "below-floor", // primary worth less than KILL_CONVERT_FLOOR_USD
  "unknown-asset", // position's assetId missing from the registry (defensive)
] as const;
export type KillSkipReason = (typeof KILL_SKIP_REASONS)[number];

export interface KillSkip {
  assetId?: string;
  symbol: string;
  usd?: number;
  reason: KillSkipReason;
}

// ---------------------------------------------------------------------------
// Payload shapes (events payload_json). Zod schemas are lenient on read
// (loose objects with defaults) so a crash mid-transition still reconstructs.
// ---------------------------------------------------------------------------

/** kill.leg payload — see the three-consumer contract in the header comment. */
export interface KillLegPayload {
  killId: string;
  legId: string;
  kind: KillLegKind;
  /** Registry id ("spyx") or primary key ("eth"/"sol"/"bnb"/"usdt"). ALWAYS
   *  present — the fills contract (see header). */
  assetId: string;
  symbol: string;
  chainId: number;
  /** Display name — receipts may name networks (doc 01 exception). */
  network: string;
  /** sell: the SPL mint / token address to sell. */
  token?: string;
  /** sell: sell-all quantity, byte-identical to the RPC string (never floated). */
  amountHuman?: string;
  /** convert: haircut USDC expect amount. */
  expectUsdc?: number;
  /** convert: SUPPORTED_TOKEN_TYPE value of the funding primary. */
  primaryType?: string;
  /** Planning-time USD estimate (progress UI); null = no mark → renders "—",
   *  never a guessed number (doc 12's honesty rule). */
  usdEst: number | null;
  outcome: KillLegState;
  attempt: number;
  transactionId?: string;
  /** Server clock at the submitted-claim (AC1 instrumentation). */
  submittedAtMs?: number;
  /** Settled only — the server's OWN extraction, never the client's claim. */
  qty?: number;
  usd?: number;
  fees?: FeeTotals;
  feeSource?: "settled" | "quoted" | "none";
  serverVerified?: boolean;
  error?: string;
  /** Terminal only — deterministic template from receipts.ts (feed contract). */
  receipt?: string;
}

export const killLegPayloadSchema = z
  .object({
    killId: z.string(),
    legId: z.string(),
    kind: z.enum(["sell", "convert"]),
    assetId: z.string(),
    symbol: z.string(),
    chainId: z.number(),
    network: z.string(),
    token: z.string().optional(),
    amountHuman: z.string().optional(),
    expectUsdc: z.number().optional(),
    primaryType: z.string().optional(),
    usdEst: z.number().nullable(),
    outcome: z.enum(KILL_LEG_STATES),
    attempt: z.number().int().default(1),
    transactionId: z.string().optional(),
    submittedAtMs: z.number().optional(),
    qty: z.number().optional(),
    usd: z.number().optional(),
    fees: feeTotalsSchema.optional(),
    feeSource: z.enum(["settled", "quoted", "none"]).optional(),
    serverVerified: z.boolean().optional(),
    error: z.string().optional(),
    receipt: z.string().optional(),
  })
  .loose();

export type KillRevokeState = "none" | "submitted" | "confirmed" | "failed";

/** kill.started payload — the kill's own row (marks, revoke, skips). */
export interface KillStartedPayload {
  killId: string;
  /** Client clocks (joined like module 02's elapsedMs — doc 16 measures AC1). */
  tapAtMs?: number;
  holdCompletedAtMs?: number;
  /** Server clock when kill.execute accepted the kill. */
  executeReceivedAtMs: number;
  revoke: {
    state: KillRevokeState;
    txHash?: string;
    error?: string;
    /** Set inside the creation tx so a concurrent execute converging on this
     *  kill never double-relays a nonce the creator is about to spend. */
    relayAttemptAtMs?: number;
    submittedAtMs?: number;
    confirmedAtMs?: number;
  };
  /** DB plan uuids flipped to revoked (audit). */
  planIds: string[];
  skipped: KillSkip[];
  legCount: number;
}

export const killStartedPayloadSchema = z
  .object({
    killId: z.string(),
    tapAtMs: z.number().optional(),
    holdCompletedAtMs: z.number().optional(),
    executeReceivedAtMs: z.number(),
    revoke: z
      .object({
        state: z.enum(["none", "submitted", "confirmed", "failed"]),
        txHash: z.string().optional(),
        error: z.string().optional(),
        relayAttemptAtMs: z.number().optional(),
        submittedAtMs: z.number().optional(),
        confirmedAtMs: z.number().optional(),
      })
      .loose(),
    planIds: z.array(z.string()).default([]),
    skipped: z
      .array(
        z
          .object({
            assetId: z.string().optional(),
            symbol: z.string(),
            usd: z.number().optional(),
            reason: z.enum(KILL_SKIP_REASONS),
          })
          .loose(),
      )
      .default([]),
    legCount: z.number().int().default(0),
  })
  .loose();

/** One leg of the aggregate kill.receipt — field-compatible with module 11's
 *  sweepLegsToDetail (network/outcome/symbol/usd/serverVerified/fees/
 *  feeSource/transactionId/error), so the feed renders it with zero changes. */
export interface KillReceiptLeg {
  chainId: number;
  network: string;
  symbol: string;
  usd: number;
  transactionId?: string;
  outcome: KillLegState;
  serverVerified: boolean;
  fees?: FeeTotals;
  feeSource?: "settled" | "quoted" | "none";
  error?: string;
}

/** kill.receipt payload — the ONE aggregate feed row. Recomputed in place
 *  when a post-aggregate retry changes a leg (counts stay honest — PROPOSED). */
export interface KillReceiptPayload {
  killId: string;
  /** killReceiptText(...) — stored verbatim, the feed's sentence. */
  receipt: string;
  liquidated: number;
  total: number;
  retryable: number;
  revoked: boolean;
  /** Aggregate fees across settled legs. */
  fees: FeeTotals;
  legs: KillReceiptLeg[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Wire schemas (signed via lib/sign.ts where the route class demands it)
// ---------------------------------------------------------------------------

/** The owner's headless personal_sign over revokeAllDigest (doc 07), plus the
 *  authNonce it commits to. Nonce travels as a decimal string (no tRPC
 *  transformer — bigints cannot cross the wire, doc 00). */
export const killRevokeAuthSchema = z.object({
  nonce: z.string().regex(/^\d+$/),
  signature: z.string().min(1).max(256),
});
export type KillRevokeAuth = z.infer<typeof killRevokeAuthSchema>;

export const killExecutePayloadSchema = z.object({
  /** Absent only when prepare said needsRevoke: false (zero onchain plans). */
  revokeAllAuth: killRevokeAuthSchema.optional(),
  /** CONFLICTS #17 instrumentation marks (client clocks). */
  tapAtMs: z.number().int().positive().optional(),
  holdCompletedAtMs: z.number().int().positive().optional(),
});
export type KillExecutePayload = z.infer<typeof killExecutePayloadSchema>;

export const killReportPhases = ["submitted", "terminal", "failed"] as const;

/** Per-leg claims. The server treats ALL of this as claims: transactionId is
 *  re-verified against Particle, outcome is re-derived server-side; a claim
 *  can only ever mark the caller's OWN legs. */
export const killReportLegPayloadSchema = z.object({
  killId: z.uuid(),
  legId: z.uuid(),
  phase: z.enum(killReportPhases),
  transactionId: z.string().min(1).max(256).optional(),
  /** What the client's own pollToTerminal saw (hint only). */
  clientOutcome: z.enum(["finished", "refunded", "timeout"]).optional(),
  /** Client-side parseFeeTotals of the executed quote (doc 03 OQ5 posture). */
  feesQuoted: feeTotalsSchema.optional(),
  error: z.string().max(500).optional(),
});
export type KillReportLegPayload = z.infer<typeof killReportLegPayloadSchema>;

export const killRetryLegPayloadSchema = z.object({
  killId: z.uuid(),
  legId: z.uuid(),
});
export type KillRetryLegPayload = z.infer<typeof killRetryLegPayloadSchema>;

// ---------------------------------------------------------------------------
// Work items — what the browser runner needs to execute one leg
// (create → sign → send in one continuous flow; quotes expire, doc 03)
// ---------------------------------------------------------------------------

export interface KillWorkItem {
  legId: string;
  kind: KillLegKind;
  assetId: string;
  symbol: string;
  chainId: number;
  /** sell: token address/mint; amountHuman = sell-all quantity. */
  token?: string;
  amountHuman?: string;
  /** convert: USDC expect amount + the funding primary's token type. */
  expectUsdc?: number;
  primaryType?: string;
  usdEst: number | null;
}
