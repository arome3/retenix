// Basket splitting (doc 08, PROPOSED mechanics — implemented exactly as
// documented): a $25 weekly 60/30/10 plan becomes three legs
// $15.00 / $7.50 / $2.50, each its own job, quote, recordExecution and
// receipt. Legs below the PS-F4.1 $1.00 minimum merge into the largest leg,
// never dropped.
//
// Determinism is load-bearing: `seq` is the leg's index in the FINAL array,
// derived purely from params order (never re-sorted) — it feeds the
// idempotency key `${planId}:${periodStartIso}:${seq}`. Identical params
// must always produce identical legs, across processes and redeploys.

import type { BrokerPlanParams } from "@retenix/shared";

export interface BasketLeg {
  /** Index within the period's basket (0..4) — part of period_key. */
  seq: number;
  assetId: string;
  /** Leg size in whole dollars.cents (number, exact to the cent). */
  usd: number;
}

const MIN_LEG_CENTS = 100; // PS-F4.1: $1 minimum per buy

/** Largest amount wins; ties break to the lowest index (deterministic). */
function largestIndex(cents: number[], skip?: number): number {
  let best = -1;
  for (let i = 0; i < cents.length; i += 1) {
    if (i === skip) continue;
    if (best === -1 || cents[i] > cents[best]) best = i;
  }
  return best;
}

export function computeLegs(
  params: Pick<BrokerPlanParams, "amountUsd" | "basket">,
): BasketLeg[] {
  const amountCents = Math.round(params.amountUsd * 100);

  // 1. Independent cent rounding per leg, in params order.
  const cents = params.basket.map((l) =>
    Math.round((amountCents * l.pct) / 100),
  );
  const assetIds = params.basket.map((l) => l.assetId);

  // 2. Fold the signed rounding residue into the largest leg so the legs
  //    sum to the plan amount exactly.
  const drift = amountCents - cents.reduce((s, c) => s + c, 0);
  if (drift !== 0) cents[largestIndex(cents)] += drift;

  // 3. Merge sub-$1 legs into the (current) largest other leg. Loop ends:
  //    every pass removes one leg, and a single remaining leg holds the
  //    whole amount (≥ $1 by the params schema).
  while (cents.length > 1) {
    let smallest = -1;
    for (let i = 0; i < cents.length; i += 1) {
      if (cents[i] < MIN_LEG_CENTS && (smallest === -1 || cents[i] < cents[smallest])) {
        smallest = i;
      }
    }
    if (smallest === -1) break;
    const into = largestIndex(cents, smallest);
    cents[into] += cents[smallest];
    cents.splice(smallest, 1);
    assetIds.splice(smallest, 1);
  }

  // 4. Re-seq in surviving (original) order.
  return cents.map((c, i) => ({ seq: i, assetId: assetIds[i], usd: c / 100 }));
}
