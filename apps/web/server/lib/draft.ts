// Deterministic server post-processing for intent drafts (doc 09, guardrail 4:
// "basket percentages re-normalized and validated server-side").
//
// Everything here is pure TS over an already-schema-validated draft — the LLM
// proposes, this file disposes. No model output reaches the response without
// passing through: drop non-positive legs → drop region-ineligible assets →
// merge duplicates → cap at 5 legs → re-normalize to exactly 100 → re-clamp
// every bound (belt-and-suspenders; the schema is the first wall) → re-validate
// against the region-narrowed schema.
//
// The raw utterance is threaded through ONLY to decide the advice-footer flag
// (PS-10.7) — it is never interpolated into any execution path (guardrail 6).
import {
  PolicyDraft as policyDraftFull,
  eligibleAssets,
} from "@retenix/registry";
import { policyDraftFor, type PolicyDraft } from "@retenix/shared";
import {
  declineReprompt,
  declineUnavailable,
  declineUnparseable,
  type IntentDecline,
} from "./intent-copy";

/** What the model call produced (see parse-intent.ts). */
export type ParseOutcome =
  | { kind: "output"; raw: unknown }
  | { kind: "no-object" }
  | { kind: "unavailable" };

/** The route's (and the eval harness's) single resolution pipeline. */
export type ResolvedParse =
  | {
      kind: "draft";
      draft: PolicyDraft;
      adviceFooter: boolean;
      droppedAssetIds: string[];
    }
  | {
      kind: "decline";
      cause: "empty" | "no-object" | "unavailable";
      decline: IntentDecline;
    };

/**
 * The region-filtered asset-id tuple (docs 04/05) — SOL/ETH are eligible
 * everywhere, so this is never empty and the tuple cast is safe.
 */
export function regionAssetIds(region: string): [string, ...string[]] {
  return eligibleAssets(region).map((a) => a.id) as [string, ...string[]];
}

/** The region-narrowed PolicyDraft schema the parser runs behind. */
export function regionDraftSchema(region: string) {
  return policyDraftFor(regionAssetIds(region));
}

/**
 * Proportionally scale to sum exactly 100 and round to integers with the
 * largest-remainder method. Worked example (doc 09): [60, 30, 20] → /110
 * proportional → [54.54…, 27.27…, 18.18…] → floors sum 99 → +1 to the largest
 * remainder → [55, 27, 18] (sums 100 exactly). Ties break by earlier index —
 * fully deterministic.
 */
export function normalizePcts(values: number[]): number[] {
  const sum = values.reduce((s, v) => s + v, 0);
  const scaled = values.map((v) => (v * 100) / sum);
  const floors = scaled.map(Math.floor);
  let deficit = 100 - floors.reduce((s, v) => s + v, 0);
  const byRemainder = scaled
    .map((v, i) => ({ i, frac: v - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = [...floors];
  for (let k = 0; deficit > 0 && k < byRemainder.length; k++, deficit--) {
    out[byRemainder[k].i] += 1;
  }
  return out;
}

/** Explicit percentages the user themselves typed ("60%", "12.5 percent"). */
export function explicitPcts(utterance: string): Set<number> {
  const out = new Set<number>();
  for (const m of utterance.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi)) {
    out.add(Number(m[1]));
  }
  return out;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Re-clamp every schema bound (guardrail 2, belt-and-suspenders — a value that
 * reached here through the schema is already in bounds, but this pipeline must
 * hold on its own). Sections left with nothing to say are dropped.
 */
export function clampDraft(draft: PolicyDraft): PolicyDraft {
  const out: PolicyDraft = {};

  if (draft.broker && draft.broker.basket.length > 0) {
    const amountUsd = round2(Math.min(draft.broker.amountUsd, 1000));
    if (amountUsd > 0) {
      out.broker = { ...draft.broker, amountUsd };
    }
  }

  if (draft.guardian) {
    const g: NonNullable<PolicyDraft["guardian"]> = {};
    if (draft.guardian.maxDrawdownPct !== undefined) {
      g.maxDrawdownPct = Math.min(90, Math.max(1, draft.guardian.maxDrawdownPct));
    }
    if (
      draft.guardian.weeklyCapUsd !== undefined &&
      draft.guardian.weeklyCapUsd > 0
    ) {
      g.weeklyCapUsd = round2(Math.min(draft.guardian.weeklyCapUsd, 5000));
    }
    if (g.maxDrawdownPct !== undefined || g.weeklyCapUsd !== undefined) {
      out.guardian = g;
    }
  }

  if (draft.legacy) {
    out.legacy = {
      beneficiaryEmail: draft.legacy.beneficiaryEmail.trim(),
      inactivityDays: Math.min(
        3650,
        Math.max(30, Math.round(draft.legacy.inactivityDays)),
      ),
    };
  }

  return out;
}

interface PostProcessed {
  draft: PolicyDraft;
  adviceFooter: boolean;
  droppedAssetIds: string[];
}

/**
 * The deterministic pipeline over a schema-valid draft. Returns null when
 * nothing usable remains (→ the canonical graceful decline).
 */
export function postProcessDraft(
  raw: PolicyDraft,
  opts: { region: string; utterance: string },
): PostProcessed | null {
  const eligibleIds = new Set(eligibleAssets(opts.region).map((a) => a.id));
  const droppedAssetIds: string[] = [];
  const draft: PolicyDraft = {};

  if (raw.broker) {
    // Drop non-positive legs, then region-ineligible assets (docs 04/05 —
    // the per-request enum already makes these unrepresentable; this layer
    // must hold even without it).
    let legs = raw.broker.basket.filter((l) => l.pct > 0);
    legs = legs.filter((l) => {
      if (eligibleIds.has(l.assetId)) return true;
      droppedAssetIds.push(l.assetId);
      return false;
    });

    // Merge duplicate assets (sum pcts, first-occurrence order — order is
    // load-bearing downstream: doc 08 derives leg seq from it).
    const byAsset = new Map<string, { assetId: string; pct: number }>();
    for (const l of legs) {
      const seen = byAsset.get(l.assetId);
      if (seen) seen.pct += l.pct;
      else byAsset.set(l.assetId, { assetId: l.assetId, pct: l.pct });
    }
    legs = [...byAsset.values()].slice(0, 5); // ≤5 legs, belt-and-suspenders

    // Re-normalize to exactly 100; a leg rounded to 0 is dropped and the rest
    // re-normalized (a 0% leg is no allocation — doc 08 requires positive).
    while (legs.length > 0) {
      const pcts = normalizePcts(legs.map((l) => l.pct));
      legs = legs.map((l, i) => ({ ...l, pct: pcts[i] }));
      if (!legs.some((l) => l.pct === 0)) break;
      legs = legs.filter((l) => l.pct > 0);
    }

    if (legs.length > 0) {
      draft.broker = {
        cadence: raw.broker.cadence,
        amountUsd: raw.broker.amountUsd,
        basket: legs,
      };
    }
  }

  if (raw.guardian) draft.guardian = { ...raw.guardian };
  if (raw.legacy) draft.legacy = { ...raw.legacy };

  const clamped = clampDraft(draft);
  if (!clamped.broker && !clamped.guardian && !clamped.legacy) return null;

  // Final wall: the response draft must satisfy the REGION-narrowed schema.
  const checked = regionDraftSchema(opts.region).safeParse(clamped);
  if (!checked.success) return null;

  // PS-10.7: the footer flag rides along whenever the basket's numbers are the
  // model's proposal rather than the user's own — i.e. any final percentage
  // the utterance did not literally state (vague allocations, and any basket
  // the re-normalization changed).
  const basket = checked.data.broker?.basket ?? [];
  const stated = explicitPcts(opts.utterance);
  const adviceFooter =
    basket.length > 0 && !basket.every((l) => stated.has(l.pct));

  return { draft: checked.data, adviceFooter, droppedAssetIds };
}

/**
 * Map a model outcome to the route response — the ONE pipeline both
 * intent.parse and the eval harness run, so the eval measures exactly what
 * production serves.
 */
export function resolveParse(
  outcome: ParseOutcome,
  opts: { region: string; utterance: string },
): ResolvedParse {
  if (outcome.kind === "no-object") {
    return {
      kind: "decline",
      cause: "no-object",
      decline: declineReprompt(opts.region),
    };
  }
  if (outcome.kind === "unavailable") {
    return {
      kind: "decline",
      cause: "unavailable",
      decline: declineUnavailable(opts.region),
    };
  }

  // Validate against the FULL registry schema first so a region-ineligible
  // asset is gracefully DROPPED below (US user + "SPYx" → asset omitted, per
  // doc 04), rather than failing the whole draft. Anything outside the pinned
  // registry still dies here (G11).
  const parsed = policyDraftFull.safeParse(outcome.raw);
  if (!parsed.success) {
    return {
      kind: "decline",
      cause: "no-object",
      decline: declineReprompt(opts.region),
    };
  }

  const post = postProcessDraft(parsed.data, opts);
  if (!post) {
    return {
      kind: "decline",
      cause: "empty",
      decline: declineUnparseable(opts.region),
    };
  }
  return { kind: "draft", ...post };
}
