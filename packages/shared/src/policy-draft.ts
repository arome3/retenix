// PolicyDraft — the intent parser's schema wall (doc 09; tech spec §8 verbatim).
//
// The LLM's only legal output is an object this schema accepts: bounds are the
// first wall (contract caps are the last), and the asset enum IS the fake-mint
// firewall — an id outside the pinned registry cannot exist in a valid draft
// (G11). Downstream, doc 10 renders drafts as cards and doc 08 executes the
// activated params; both consume this module.
//
// Shape single-source, ids injected: @retenix/registry depends on this package
// (see plan-params.ts — same constraint), so importing REGISTRY_IDS here would
// make the shared ↔ registry project references circular and break `tsc -b`.
// The spec block's schema body therefore lives here ONCE, as a builder over an
// id tuple; the concrete spec binding `policyDraftFor(REGISTRY_IDS)` is
// exported by @retenix/registry (its policy-draft.ts), and intent.parse builds
// the region-narrowed variant per request — a blocked-region user's parser
// literally cannot name SPYx.

import { z } from "zod";

/**
 * The tech-spec §8 PolicyDraft schema over an asset-id tuple (`z.enum` input
 * shape, doc 05). The object body below is the spec block byte-for-byte with
 * `REGISTRY_IDS` as the injected `ids` parameter.
 */
export function policyDraftFor(ids: [string, ...string[]]) {
  return z.object({
    broker: z.object({ cadence: z.enum(["daily","weekly","monthly"]),
      amountUsd: z.number().positive().max(1000),
      basket: z.array(z.object({ assetId: z.enum(ids), pct: z.number() })).max(5),
    }).optional(),
    guardian: z.object({ maxDrawdownPct: z.number().min(1).max(90).optional(),
      weeklyCapUsd: z.number().positive().max(5000).optional() }).optional(),
    legacy: z.object({ beneficiaryEmail: z.string().email(),
      inactivityDays: z.number().min(30).max(3650) }).optional(),
  });
}

/**
 * The draft type modules 08/10 consume. Asset ids type as `string` here (the
 * registry tuple is not a literal union); pinned-registry membership is
 * enforced at runtime by the enum and re-checked by the worker preflight.
 */
export type PolicyDraft = z.infer<ReturnType<typeof policyDraftFor>>;

/** One basket leg of a draft (doc 10 renders these; order is meaningful). */
export type PolicyDraftBasketLeg = NonNullable<
  PolicyDraft["broker"]
>["basket"][number];
