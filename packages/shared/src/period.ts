// Period arithmetic shared between the worker (doc 08) and the policy
// contract (doc 07). periodOf reproduces RetenixPolicy.recordExecution's
// inline rollover EXACTLY:
//
//   if (block.timestamp >= uint256(p.periodStart) + p.periodSecs) {
//       p.periodStart = uint32(block.timestamp)
//           - (uint32(block.timestamp) - p.periodStart) % p.periodSecs;
//       p.spentInPeriod = 0;
//   }
//
// Cross-impl vectors live in contracts/test/fixtures/period-vectors.json,
// asserted by BOTH period.test.ts and contracts/test/PeriodVectors.t.sol —
// drift in either implementation goes red.
//
// All timestamps are UTC unix SECONDS (the contract's unit); cadence helpers
// below work in Date/ms but only ever through UTC accessors (TS-7.2).

export interface PeriodWindow {
  periodStart: number;
  periodEnd: number;
}

/**
 * Current cap window for a plan, per the contract's lazy rollover. `p` is
 * the last stored state (from the `plans(id)` view call or activation);
 * the returned window is what the contract WOULD hold after its next write.
 */
export function periodOf(
  p: { periodStart: number; periodSecs: number },
  nowSec: number,
): PeriodWindow {
  const { periodStart, periodSecs } = p;
  if (!Number.isInteger(periodStart) || periodStart < 0) {
    throw new Error(`periodOf: bad periodStart ${periodStart}`);
  }
  if (!Number.isInteger(periodSecs) || periodSecs <= 0) {
    throw new Error(`periodOf: bad periodSecs ${periodSecs} (contract guards ZeroPeriod)`);
  }
  if (!Number.isInteger(nowSec) || nowSec < 0) {
    throw new Error(`periodOf: bad now ${nowSec}`);
  }
  if (nowSec >= periodStart + periodSecs) {
    const rolled = nowSec - ((nowSec - periodStart) % periodSecs);
    return { periodStart: rolled, periodEnd: rolled + periodSecs };
  }
  return { periodStart, periodEnd: periodStart + periodSecs };
}

/**
 * spentInPeriod as the contract would see it at `nowSec`: zero if the
 * window rolled since the last onchain write. Used by the worker's step-3
 * preflight so cap comparisons match the contract's own arithmetic
 * (usd6 bigints throughout — CONFLICTS #11).
 */
export function effectiveSpent(
  p: { periodStart: number; periodSecs: number; spentInPeriod: bigint },
  nowSec: number,
): bigint {
  const rolled =
    periodOf({ periodStart: p.periodStart, periodSecs: p.periodSecs }, nowSec)
      .periodStart !== p.periodStart;
  return rolled ? 0n : p.spentInPeriod;
}

// ---------------------------------------------------------------------------
// Cadence → run schedule (PROPOSED, spec-silent — doc 08 fixes the rules:
// daily = 24 h from activation time; weekly = same weekday+time; monthly =
// same day-of-month, clamped. The grid anchors to ACTIVATION so a clamped
// February run returns to the 31st in March instead of drifting.)
// ---------------------------------------------------------------------------

export type Cadence = "daily" | "weekly" | "monthly";

/** Contract cap window per cadence (PROPOSED: monthly caps use a fixed
 *  30-day window; the calendar-aware run grid is a separate concern). */
export const CADENCE_PERIOD_SECS: Record<Cadence, number> = {
  daily: 86_400,
  weekly: 604_800,
  monthly: 2_592_000,
};

const DAY_MS = 86_400_000;

/** anchor + k months, day-of-month clamped to the target month (UTC). */
function addMonthsClamped(anchor: Date, k: number): Date {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + k;
  const daysInTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(anchor.getUTCDate(), daysInTarget),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/**
 * Smallest grid point STRICTLY after `from`, where the grid is anchored at
 * `anchor` (activation) and stepped by the cadence. The first scheduled run
 * of a fresh plan is therefore anchor + one step; the optional activation-
 * time buy is `execute-now`'s job, not the grid's.
 */
export function nextCadenceRun(cadence: Cadence, anchor: Date, from: Date): Date {
  if (cadence === "monthly") {
    const approx =
      (from.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      (from.getUTCMonth() - anchor.getUTCMonth());
    let k = Math.max(0, approx - 1); // candidate(k) is guaranteed ≤ from (earlier month)
    let candidate = addMonthsClamped(anchor, k);
    while (candidate.getTime() <= from.getTime()) {
      k += 1;
      candidate = addMonthsClamped(anchor, k);
    }
    return candidate;
  }
  const step = cadence === "daily" ? DAY_MS : 7 * DAY_MS;
  const diff = from.getTime() - anchor.getTime();
  const k = diff < 0 ? 0 : Math.floor(diff / step) + 1;
  return new Date(anchor.getTime() + k * step);
}

/**
 * One scheduler advance: the run happening NOW stands in for `storedNext`;
 * grid points strictly between `storedNext` and `now` were MISSED (worker
 * downtime) and are rolled past without catch-up buys — stacking N periods
 * of purchases is not what the user scheduled (doc 08). `missed > 0` should
 * be surfaced as a `plan.periods_missed` event.
 */
export function advanceSchedule(
  cadence: Cadence,
  anchor: Date,
  storedNext: Date,
  now: Date,
): { next: Date; missed: number } {
  const next = nextCadenceRun(cadence, anchor, now);
  let missed = 0;
  let p = nextCadenceRun(cadence, anchor, storedNext);
  while (p.getTime() <= now.getTime()) {
    missed += 1;
    p = nextCadenceRun(cadence, anchor, p);
  }
  return { next, missed };
}
