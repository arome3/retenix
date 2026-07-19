// The Guardian drawdown trigger (doc 19, F12) — pure evaluation, no I/O.
//
// WHAT THIS IS: the thing that makes `maxDrawdownPct` mean something. Before
// doc 19 that field was parsed, clamped, stored, rendered on the card and named
// in a receipt — and never evaluated by anything. `scheduler.ts` filters
// `kind = "broker"`, so guardian rows were structurally invisible to the
// worker. It was doc 13's deferred P1 (§F6.3, "build only if W4 allows").
//
// WHAT IT COSTS: acting on a mark crosses marks.ts's display-only invariant for
// the first time (see the amended header there). Every guard below exists to
// make that crossing defensible, and the Ostium exploit — a compromised oracle
// signer pushing future-dated prices — is the reason none of them are optional.
//
// The design bias throughout: a feed that misbehaves must degrade to INACTION.
// Not firing when we should have costs the user a hedge they can still open by
// hand; firing when we should not have opens a real position on a fake price.
//
// DRAWDOWN HERE MEANS PEAK-TO-CURRENT, not the cost-basis `deltaPct` the
// portfolio row shows. "Down 15%" in ordinary speech means from the high, and
// that is what the Guardian card promises. The two disagree whenever a holding
// is up on cost but off its peak — flagged for the copy owner in HANDOFF §19.

/** Separate confirming reads required before a crossing fires. */
export const CONFIRMATIONS_REQUIRED = 3;
/** ...spanning at least this long, so three fast ticks cannot rush it. */
export const MIN_CONFIRM_SPAN_MS = 20 * 60_000;
/** A mark moving more than this since the last read is unusable, not a signal. */
export const JUMP_GUARD_PCT = 35;
/** A peak younger than this cannot anchor a drawdown (no instant high-water). */
export const MIN_PEAK_AGE_MS = 60 * 60_000;
/** Positions below this can't manufacture a trigger out of rounding. */
export const MIN_PEAK_USD = 25;
/** Silence after a fire, so one drawdown opens one hedge. */
export const TRIGGER_COOLDOWN_MS = 6 * 60 * 60_000;

export type DrawdownUnusableReason =
  | "stale-mark"
  | "jump-guard"
  | "no-peak"
  | "peak-too-young"
  | "peak-too-small"
  | "cooling-down";

export type DrawdownVerdict =
  /** Healthy — above the threshold. Any armed state should be cleared. */
  | { state: "below"; drawdownPct: number }
  /** Cannot judge safely. NOT a trigger, and NOT a reason to disarm. */
  | { state: "unusable"; reason: DrawdownUnusableReason }
  /** Crossed, but not yet confirmed enough times / for long enough. */
  | { state: "arming"; drawdownPct: number; confirmations: number }
  /** Confirmed. This is the only verdict that may open a hedge. */
  | {
      state: "fire";
      drawdownPct: number;
      peakUsd: number;
      currentUsd: number;
      peakAtMs: number;
    };

export interface DrawdownObservation {
  /** Mark at the previous read — the jump guard's baseline. */
  markUsd: number;
  atMs: number;
}

export interface DrawdownArmedState {
  firstAtMs: number;
  confirmations: number;
}

export interface DrawdownInput {
  /** `params_json.maxDrawdownPct` — already clamped to 1..90 upstream. */
  thresholdPct: number;
  peak: { valueUsd: number; atMs: number } | null;
  current: { valueUsd: number; markUsd: number; stale: boolean };
  previousObservation: DrawdownObservation | null;
  armed: DrawdownArmedState | null;
  lastTriggerAtMs: number | null;
  nowMs: number;
}

/** Percentage fall from peak to current; 0 when at or above the peak. */
export function drawdownPct(peakUsd: number, currentUsd: number): number {
  if (peakUsd <= 0) return 0;
  const fall = ((peakUsd - currentUsd) / peakUsd) * 100;
  return fall > 0 ? fall : 0;
}

/**
 * The whole trigger decision, as one pure function over already-fetched data.
 * Pure so it can be exhaustively tested without a DB, a clock or a price feed —
 * the three things that make trigger bugs invisible until they fire live.
 */
export function evaluateDrawdown(input: DrawdownInput): DrawdownVerdict {
  const { thresholdPct, peak, current, previousObservation, armed, lastTriggerAtMs, nowMs } =
    input;

  // 1. A stale mark is the last-trade fallback, not a live price. A feed
  //    outage must never be able to fire anything.
  if (current.stale) return { state: "unusable", reason: "stale-mark" };

  // 2. Cooldown. One drawdown opens one hedge; without this a position that
  //    hovers at the threshold reopens a hedge every scan.
  if (lastTriggerAtMs !== null && nowMs - lastTriggerAtMs < TRIGGER_COOLDOWN_MS) {
    return { state: "unusable", reason: "cooling-down" };
  }

  // 3. Peak hygiene. No peak, a peak minted moments ago, or a dust-sized peak
  //    cannot anchor a real drawdown.
  if (peak === null) return { state: "unusable", reason: "no-peak" };
  if (nowMs - peak.atMs < MIN_PEAK_AGE_MS) {
    return { state: "unusable", reason: "peak-too-young" };
  }
  if (peak.valueUsd < MIN_PEAK_USD) {
    return { state: "unusable", reason: "peak-too-small" };
  }

  // 4. Jump guard. A mark that leaps beyond JUMP_GUARD_PCT since the previous
  //    read is exactly the signature of a poisoned tick — the Ostium attacker
  //    delivered a fabricated $5,000 BTC print. Unusable, never triggering.
  if (previousObservation !== null && previousObservation.markUsd > 0) {
    const jump =
      (Math.abs(current.markUsd - previousObservation.markUsd) / previousObservation.markUsd) *
      100;
    if (jump > JUMP_GUARD_PCT) return { state: "unusable", reason: "jump-guard" };
  }

  const pct = drawdownPct(peak.valueUsd, current.valueUsd);
  if (pct < thresholdPct) return { state: "below", drawdownPct: pct };

  // 5. N-of-M confirmation. The crossing must persist across separate reads AND
  //    across real time — three reads inside a minute prove nothing about a
  //    feed that is briefly wrong.
  const confirmations = (armed?.confirmations ?? 0) + 1;
  const firstAtMs = armed?.firstAtMs ?? nowMs;
  const spanMs = nowMs - firstAtMs;
  if (confirmations < CONFIRMATIONS_REQUIRED || spanMs < MIN_CONFIRM_SPAN_MS) {
    return { state: "arming", drawdownPct: pct, confirmations };
  }

  return {
    state: "fire",
    drawdownPct: pct,
    peakUsd: peak.valueUsd,
    currentUsd: current.valueUsd,
    peakAtMs: peak.atMs,
  };
}

/**
 * The armed state to persist after a verdict. `null` means "clear it".
 *
 * Note `unusable` KEEPS the existing state rather than clearing it: a single
 * unreadable scan in the middle of a real drawdown should not reset the
 * confirmation count and make the user wait another full span.
 */
export function nextArmedState(
  verdict: DrawdownVerdict,
  armed: DrawdownArmedState | null,
  nowMs: number,
): DrawdownArmedState | null {
  switch (verdict.state) {
    case "arming":
      return { firstAtMs: armed?.firstAtMs ?? nowMs, confirmations: verdict.confirmations };
    case "unusable":
      return armed;
    case "below":
    case "fire":
      return null;
  }
}

/** One `portfolio_snapshots` row, narrowed to what the peak scan needs. */
export interface SnapshotRowLike {
  perAssetJson: unknown;
  atMs: number;
}

/**
 * Peak value for one asset across snapshot rows. Rows are the durable,
 * hourly-written audit trail, which is why the peak comes from them rather than
 * from a live read: poisoning a peak would require sustained corruption across
 * hours, each hour leaving a record.
 */
export function peakFromSnapshots(
  rows: readonly SnapshotRowLike[],
  assetId: string,
): { valueUsd: number; atMs: number } | null {
  let best: { valueUsd: number; atMs: number } | null = null;
  for (const row of rows) {
    const perAsset = row.perAssetJson as Record<string, { valueUsd?: unknown }> | null | undefined;
    const raw = perAsset?.[assetId]?.valueUsd;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) continue;
    if (best === null || raw > best.valueUsd) best = { valueUsd: raw, atMs: row.atMs };
  }
  return best;
}
