// Card → onchain params mapping (doc 10 §Activation flow step 2, doc 07's
// card→onchain mapping). Pure math, unit-pinned — the ONLY usd6 encode site in
// the web app (the other in the whole codebase is module 08's recordExecution;
// CONFLICTS #11).
//
// One contract Plan per activation: the Broker card is the plan (cadence/amount
// live in params_json), the Guardian card is the caps ON that same plan
// (capPerExec/capPerPeriod/assetListHash). The Legacy card is an Estate — no
// Plan row (contract_plan_id stays null), handled by module 14.
import { computeLegs, toUsd6 } from "@retenix/shared";
import { assetListHash } from "@retenix/registry";
import type { BrokerSection, GuardianSection } from "@retenix/shared";

/** PROPOSED periodSecs table (doc 10 step 2). Monthly = 30 days, matching the
 *  contract cap window in @retenix/shared CADENCE_PERIOD_SECS (doc 08). Doc 10
 *  writes 2629746 (avg calendar month); reconciled to 2592000 so the cap
 *  window the contract enforces equals the window the worker measures spend
 *  against — a mismatch would let spend straddle the boundary differently on
 *  each side. Flagged in HANDOFF. */
export const CADENCE_PERIOD_SECS = {
  daily: 86_400,
  weekly: 604_800,
  monthly: 2_592_000,
} as const;

export interface OnchainPlanParams {
  /** usd6 — max any single execution (largest FINAL basket leg). */
  capPerExec: bigint;
  /** usd6 — max total spend per period (tightest applicable cap). */
  capPerPeriod: bigint;
  periodSecs: number;
  /** keccak of the sorted, "|"-joined basket ids — the signature commitment. */
  assetListHash: string;
  /** The pre-sorted plaintext ids createPlan needs (preimage of the hash). */
  assetIds: string[];
}

/**
 * capPerExec = toUsd6(largest FINAL leg) — PROPOSED "largest-leg" rule (doc 10).
 *
 * "Final" is load-bearing: sub-$1 legs merge upward (module 08's computeLegs),
 * so a merged leg can exceed its naive pct×amount. Sizing capPerExec off the
 * pre-merge legs would make the contract block the worker's own largest leg.
 * A single-buy (no basket split) plan has capPerExec == amountUsd.
 */
export function capPerExecUsd(broker: BrokerSection): number {
  const legs = computeLegs({ amountUsd: broker.amountUsd, basket: broker.basket });
  return Math.max(...legs.map((l) => l.usd));
}

/**
 * capPerPeriod = the tightest applicable cap, normalized to the plan's period.
 *
 * Reading of the doc's "min(guardian.weeklyCapUsd ?? amountUsd, …)" ellipsis
 * (adopted per the module prompt, pinned by test): the tightest of
 *   - the guardian weekly cap, scaled from a 7-day week to this plan's period;
 *   - the broker amount itself, one execution per period → amountUsd per period.
 * With no guardian cap, the plan's own amount is the period ceiling (a plan
 * can never legitimately spend more than one cadence's amount in one period).
 */
export function capPerPeriodUsd(
  broker: BrokerSection,
  guardian: GuardianSection | undefined,
  periodSecs: number,
): number {
  const fromAmount = broker.amountUsd;
  if (guardian?.weeklyCapUsd === undefined) return fromAmount;
  const scaled = (guardian.weeklyCapUsd * periodSecs) / CADENCE_PERIOD_SECS.weekly;
  return Math.min(fromAmount, scaled);
}

/**
 * Build the contract params for a Broker (+ optional merged Guardian) card.
 * Basket ids are sorted the way assetListHash's preimage requires (the owner's
 * signature covers the hash; the relayer passes exactly these ids).
 */
export function toOnchainPlanParams(
  broker: BrokerSection,
  guardian: GuardianSection | undefined,
): OnchainPlanParams {
  const periodSecs = CADENCE_PERIOD_SECS[broker.cadence];
  const assetIds = [...new Set(broker.basket.map((l) => l.assetId))].sort();
  return {
    capPerExec: toUsd6(capPerExecUsd(broker)),
    capPerPeriod: toUsd6(capPerPeriodUsd(broker, guardian, periodSecs)),
    periodSecs,
    assetListHash: assetListHash(assetIds),
    assetIds,
  };
}
