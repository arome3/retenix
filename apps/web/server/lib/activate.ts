// Activation resolution (doc 10 §Activation flow) — the pure, testable core of
// plans.activate: take a stored draft + the user's accept flags/edits, produce
// the validated sections that will become rows and (for the broker) the
// onchain params. The router does the DB writes and the relay; this decides
// WHAT gets written, re-validating every value against doc 09's schema and the
// user's region (client-edited values re-enter the same wall).
import { eligibleAssets, type AssetAccess } from "@retenix/registry";
import {
  brokerSectionSchema,
  guardianSectionSchema,
  legacySectionSchema,
  policyDraftFor,
  type BrokerSection,
  type GuardianSection,
  type LegacySection,
  type PolicyDraft,
} from "@retenix/shared";
import { normalizePcts } from "./draft";
import {
  toOnchainPlanParams,
  type OnchainPlanParams,
} from "./activation-mapping";

export interface ActivateAccept {
  broker: boolean;
  guardian: boolean;
  legacy: boolean;
}
export interface ActivateEdits {
  broker?: BrokerSection;
  guardian?: GuardianSection;
  legacy?: LegacySection;
}

export type ActivateResolution =
  | { ok: false; reason: string }
  | {
      ok: true;
      broker?: BrokerSection;
      guardian?: GuardianSection;
      legacy?: LegacySection;
      /** Onchain params when a contract plan is created (broker present). */
      onchain?: OnchainPlanParams;
      /** True when the guardian was accepted but no broker exists to guard. */
      standaloneGuardian: boolean;
    };

/**
 * A user-edited section must satisfy the region-narrowed schema exactly as a
 * parsed one did (doc 10 security: "client-edited values re-enter the same
 * validation"). Basket pcts are re-normalized + region-dropped so an edit that
 * doesn't sum to 100 or names a hidden asset is corrected, not trusted raw.
 */
function normalizeBrokerEdit(
  broker: BrokerSection,
  region: string,
  access: AssetAccess,
): BrokerSection | null {
  const eligible = new Set(eligibleAssets(region, access).map((a) => a.id));
  let legs = broker.basket
    .filter((l) => l.pct > 0 && eligible.has(l.assetId))
    .map((l) => ({ ...l }));
  if (legs.length === 0) return null;

  // dedupe (order preserved — leg seq is load-bearing, doc 08)
  const byAsset = new Map<string, { assetId: string; pct: number }>();
  for (const l of legs) {
    const seen = byAsset.get(l.assetId);
    if (seen) seen.pct += l.pct;
    else byAsset.set(l.assetId, { ...l });
  }
  legs = [...byAsset.values()].slice(0, 5);
  while (legs.length > 0) {
    const pcts = normalizePcts(legs.map((l) => l.pct));
    legs = legs.map((l, i) => ({ ...l, pct: pcts[i] }));
    if (!legs.some((l) => l.pct === 0)) break;
    legs = legs.filter((l) => l.pct > 0);
  }
  return { ...broker, basket: legs };
}

/**
 * Resolve an activation. `draft` is the STORED draft (module 09); `edits`
 * override sections the user changed on the cards. Every returned value is
 * schema-valid and region-legal.
 */
export function resolveActivation(args: {
  draft: PolicyDraft;
  accept: ActivateAccept;
  edits?: ActivateEdits;
  region: string;
  /** doc 18 F11 — omitted means locked (fail-closed), never "allow". */
  leveragedUnlocked?: boolean;
}): ActivateResolution {
  const { draft, accept, edits, region } = args;
  const access: AssetAccess = { leveragedUnlocked: args.leveragedUnlocked };
  const regionSchema = policyDraftFor(
    eligibleAssets(region, access).map((a) => a.id) as [string, ...string[]],
  );

  // --- broker ---
  let broker: BrokerSection | undefined;
  if (accept.broker) {
    const raw = edits?.broker ?? draft.broker;
    if (!raw) return { ok: false, reason: "no broker section to activate" };
    // PS-F4.1: the $1 floor the draft schema doesn't enforce (module 09 note).
    if (raw.amountUsd < 1) return { ok: false, reason: "broker amount below $1" };
    const normalized = normalizeBrokerEdit(raw, region, access);
    if (!normalized) {
      return { ok: false, reason: "broker basket empty after region filter" };
    }
    const parsed = brokerSectionSchema.safeParse(normalized);
    if (!parsed.success) return { ok: false, reason: "broker section invalid" };
    // final wall: the whole thing must satisfy the region draft schema too
    if (!regionSchema.safeParse({ broker: parsed.data }).success) {
      return { ok: false, reason: "broker draft out of bounds for region" };
    }
    broker = parsed.data;
  }

  // --- guardian ---
  let guardian: GuardianSection | undefined;
  if (accept.guardian) {
    const raw = edits?.guardian ?? draft.guardian;
    if (!raw) return { ok: false, reason: "no guardian section to activate" };
    const parsed = guardianSectionSchema.safeParse(raw);
    if (
      !parsed.success ||
      (parsed.data.maxDrawdownPct === undefined &&
        parsed.data.weeklyCapUsd === undefined)
    ) {
      return { ok: false, reason: "guardian section invalid" };
    }
    guardian = parsed.data;
  }

  // --- legacy ---
  let legacy: LegacySection | undefined;
  if (accept.legacy) {
    const raw = edits?.legacy ?? draft.legacy;
    if (!raw) return { ok: false, reason: "no legacy section to activate" };
    const parsed = legacySectionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "legacy section invalid" };
    legacy = parsed.data;
  }

  if (!broker && !guardian && !legacy) {
    return { ok: false, reason: "nothing accepted" };
  }

  // A guardian merges into the broker's ONE contract plan (doc 07 mapping);
  // without a broker it is standalone (doc 10 step 5 PROPOSED).
  const standaloneGuardian = Boolean(guardian && !broker);
  const onchain = broker ? toOnchainPlanParams(broker, guardian) : undefined;

  return { ok: true, broker, guardian, legacy, onchain, standaloneGuardian };
}
