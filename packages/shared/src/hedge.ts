// The hedge venue port (doc 19, F12) — the seam between Guardian Hedge mode
// and whatever perps venue is actually live.
//
// WHY A PORT AND NOT AN OSTIUM CLIENT: doc 19 pins Ostium. On 2026-07-15 Ostium
// was drained via a compromised oracle signer key and its Trading contract now
// reads isPaused() = true AND isDone() = true on Arbitrum One — `isDone` is the
// Gains-fork DECOMMISSION flag, so the venue redeploys rather than unpauses and
// any address pinned today is stale regardless. Gate G-H1 therefore failed on a
// venue outage, not on integration difficulty (HANDOFF §19).
//
// The lesson generalises past this one incident: a hedge venue is a third party
// that can pause, freeze collateral, or be replaced wholesale, and none of that
// may be allowed to reach the user's kill switch. So unavailability is modelled
// as an ORDINARY RESULT here, not an exception.

/** Which venue an adapter speaks to. `none` is the null venue — what ships. */
export type VenueId = "none" | "ostium" | "gtrade";

export type VenueUnavailableReason =
  /** Contracts paused or decommissioned (Ostium's current state). */
  | "venue-paused"
  /** Equity pair outside NYSE hours (G-H2 / PS-F12-AC5). */
  | "market-closed"
  /** The fulfillment oracle is not publishing — never assume a fill. */
  | "oracle-stale"
  | "insufficient-liquidity"
  | "rate-limited"
  /** RPC or subgraph unreachable. */
  | "network"
  /** HEDGE_ENABLED=0, or no venue address pinned. The default. */
  | "not-configured";

/**
 * Every venue call returns one of these. `VenueUnavailable` is a FIRST-CLASS
 * RESULT, deliberately not a thrown error:
 *
 *  1. the worker's rule is that business failures never throw — a throw routes
 *     into pg-boss crash-retry, which would hammer a paused venue and burn the
 *     job's retry budget on a condition that is not transient;
 *  2. the kill switch must be able to ask "is this venue reachable?" and get an
 *     answer in one round trip without a try/catch deciding its control flow.
 *
 * `rejected` is different in kind: the venue was reachable and said no.
 */
export type VenueOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: "unavailable";
      reason: VenueUnavailableReason;
      /** null when retrying cannot help (paused, not-configured). */
      retryAfterMs: number | null;
      detail?: string;
    }
  | { ok: false; kind: "rejected"; reason: string; detail?: string };

export const venueOk = <T>(value: T): VenueOutcome<T> => ({ ok: true, value });

export const venueUnavailable = <T>(
  reason: VenueUnavailableReason,
  retryAfterMs: number | null = null,
  detail?: string,
): VenueOutcome<T> => ({ ok: false, kind: "unavailable", reason, retryAfterMs, detail });

export const venueRejected = <T>(reason: string, detail?: string): VenueOutcome<T> => ({
  ok: false,
  kind: "rejected",
  reason,
  detail,
});

/** A minimal EVM call the worker will fund through createUniversalTransaction. */
export interface VenueTransaction {
  to: string;
  data: string;
  value?: string;
}

export interface OpenQuote {
  pairId: string;
  notionalUsd: number;
  leverageX10: number;
  collateralUsd: number;
  estEntryPrice: number;
  estFeesUsd: number;
  estLiquidationPrice: number;
  quotedAtMs: number;
  /** Past this, re-quote and RE-CHECK CAPS — never send a stale quote. */
  expiresAtMs: number;
}

export interface VenuePosition {
  venueOrderId: string;
  pairId: string;
  /** Literal `false`: a long is unrepresentable in this type, by design. */
  isLong: false;
  notionalUsd: number;
  leverageX10: number;
  collateralUsd: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnlUsd: number;
  /** Funding accrued against the hedge — folded into P&L, never hidden. */
  fundingPaidUsd: number;
  liquidationPrice: number;
  /** (mark → liquidation) / mark. See the two thresholds below. */
  liquidationBufferPct: number;
  openedAtMs: number;
}

/** doc 19 §Security: alert at a 20% buffer... */
export const LIQUIDATION_ALERT_BUFFER_PCT = 0.2;
/** ...auto-close at 10%. Closing early is always cheaper than liquidation. */
export const LIQUIDATION_AUTOCLOSE_BUFFER_PCT = 0.1;

/** The off-hours proxy pair, pre-approved by the user at enable time. */
export const PROXY_PAIR_DEFAULT = "BTC/USD";

export interface HedgeVenue {
  readonly id: VenueId;
  readonly chainId: number;

  /**
   * Cheap liveness probe. The KILL SWITCH calls this first: a known-paused
   * venue then costs the kill path zero seconds instead of a full close
   * timeout. Keep it to one round trip.
   */
  health(): Promise<VenueOutcome<{ paused: boolean }>>;

  /** Registry asset id → venue pair id ("tslax" → "TSLA/USD"); null = unsupported. */
  pairFor(assetId: string): string | null;

  quoteOpen(req: {
    pairId: string;
    notionalUsd: number;
    leverageX10: number;
  }): Promise<VenueOutcome<OpenQuote>>;

  /**
   * MUST return calldata only — never broadcasts. The worker funds it through
   * createUniversalTransaction so collateral comes from the unified balance.
   * `clientOrderId` is the venue-side idempotency key.
   */
  buildOpen(req: {
    quote: OpenQuote;
    ownerAddress: string;
    clientOrderId: string;
  }): Promise<VenueOutcome<{ transactions: VenueTransaction[]; expectUsdc: number }>>;

  buildClose(req: {
    position: VenuePosition;
    ownerAddress: string;
    clientOrderId: string;
  }): Promise<VenueOutcome<{ transactions: VenueTransaction[] }>>;

  /** Oracle-fulfilled venues settle asynchronously — poll after send. */
  readPosition(req: {
    ownerAddress: string;
    pairId: string;
    clientOrderId: string;
  }): Promise<VenueOutcome<VenuePosition | null>>;

  /**
   * Off-hours path (PS-F12-AC5). Optional: a venue without resting orders
   * simply omits it, and the caller falls through to the proxy pair. An
   * unsupported call must still return `unavailable`, never throw.
   */
  queueLimitOpen?(req: {
    quote: OpenQuote;
    limitPrice: number;
    goodTilMs: number;
  }): Promise<VenueOutcome<{ venueOrderId: string }>>;
}

/** True when the position is close enough to liquidation to warn the user. */
export function needsLiquidationAlert(p: Pick<VenuePosition, "liquidationBufferPct">): boolean {
  return p.liquidationBufferPct <= LIQUIDATION_ALERT_BUFFER_PCT;
}

/** True when the worker must close NOW rather than risk liquidation fees. */
export function needsLiquidationAutoClose(
  p: Pick<VenuePosition, "liquidationBufferPct">,
): boolean {
  return p.liquidationBufferPct <= LIQUIDATION_AUTOCLOSE_BUFFER_PCT;
}

/**
 * Why a hedge could not be opened, in words a receipt can use. Never claims a
 * position exists — doc 19 §Security: "never assume hedged until fill
 * confirmed".
 */
export function unavailableSummary(reason: VenueUnavailableReason): string {
  switch (reason) {
    case "market-closed":
      return "the market is closed";
    case "venue-paused":
      return "protection is paused";
    case "oracle-stale":
      return "prices went quiet";
    case "insufficient-liquidity":
      return "there wasn't enough depth";
    case "rate-limited":
      return "we were rate-limited";
    case "network":
      return "we couldn't reach it";
    case "not-configured":
      return "protection isn't switched on yet";
  }
}
