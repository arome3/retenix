// Broker-plan params_json read-contract (PROPOSED, spec-silent — doc 08).
// The worker schedules and executes off this shape; docs 09 (intent → draft)
// and 10 (activation) MUST write params that satisfy it (recorded in
// HANDOFF). Asset ids are shape-checked only here: @retenix/registry depends
// on this package, so the pinned-registry membership check (G11) lives in
// the worker's preflight, where it is required anyway.

import { z } from "zod";

import type { Cadence } from "./period";

export const cadenceSchema = z.enum([
  "daily",
  "weekly",
  "monthly",
]) satisfies z.ZodType<Cadence>;

/** One basket entry; `pct` is a percentage (60 = 60%). Order is meaningful:
 *  leg `seq` derives from this order and must never be re-sorted — the
 *  idempotency key `(planId, periodStart, seq)` depends on it. */
export const brokerBasketLegSchema = z.object({
  assetId: z.string().min(1),
  pct: z.number().positive().max(100),
});

export const brokerParamsSchema = z
  .object({
    cadence: cadenceSchema,
    /** Total per run; PS-F4.1 fixes the $1 minimum. */
    amountUsd: z.number().min(1),
    /** 1–5 legs (contract allowlist holds ≤5 assets, doc 07). */
    basket: z.array(brokerBasketLegSchema).min(1).max(5),
    capPerExecUsd: z.number().positive(),
    capPerPeriodUsd: z.number().positive(),
    /** Contract cap window (usd6 caps roll on this — doc 07). */
    periodSecs: z.number().int().positive(),
    /** Next scheduled run, ISO 8601 UTC; the scheduler CAS-advances it. */
    nextRunAt: z.iso.datetime(),
    /** PS-F4.4: top-up prompt is opt-in per plan; skip-and-notify default. */
    topUpOptIn: z.boolean().optional().default(false),
  })
  .refine(
    (p) => Math.abs(p.basket.reduce((s, l) => s + l.pct, 0) - 100) < 0.001,
    { message: "basket percentages must sum to 100 (doc 09 re-normalizes at draft time)" },
  );

export type BrokerPlanParams = z.infer<typeof brokerParamsSchema>;
