/*
 * Pure display helpers for C4 receipt rows (doc 11) — extracted so the render
 * rules are node-unit-testable (repo convention: no component-test harness;
 * logic lives in pure functions, behavior is proven in Playwright).
 */
import type { FeedAgent, FeedVariant, LegDetail } from "@retenix/shared";
import { fmtUsd as receiptUsd } from "@retenix/shared";
import type { BrokerSection, GuardianSection, LegacySection } from "@retenix/shared";
import { absTime, relTime } from "@/lib/format";
import {
  brokerTerms,
  guardianTerms,
  legacyTerms,
  type PolicyTerm,
} from "@/lib/policy-terms";

// ---------------------------------------------------------------------------
// Timestamps (DS-9.4 — relTime/absTime consumed verbatim, never reimplemented)
// ---------------------------------------------------------------------------

export interface ReceiptTimestamp {
  /** "just now" <1m → "3:12 PM" <1d → "Yesterday at 3:12 PM" → "12d ago" <30d → absolute. */
  relative: string;
  /** The mandated tooltip companion — ALWAYS absolute. */
  absolute: string;
}

/** nowMs is injected (react-hooks/purity: render never reads the wall clock)
 *  and frozen while the feed is paused, so timestamps stop ticking too. */
export function receiptTimestamp(atIso: string, nowMs: number): ReceiptTimestamp {
  const at = new Date(atIso);
  return { relative: relTime(at, new Date(nowMs)), absolute: absTime(at) };
}

// ---------------------------------------------------------------------------
// Variant mark (C4): executed = teal plan-kind avatar · blocked = amber shield
// (the guardian seen working — full prominence, G14-distinct from loss red) ·
// failed-refunded / system = muted. Avatars are fixed teal brand constants and
// are never recolored; muting is opacity on the mark container.
// ---------------------------------------------------------------------------

export type ReceiptMark =
  | { type: "avatar"; agent: FeedAgent; muted: boolean }
  | { type: "shield" }
  | { type: "dot" };

export function receiptMark(variant: FeedVariant, agent: FeedAgent | null): ReceiptMark {
  if (variant === "blocked") return { type: "shield" };
  if (variant === "executed") {
    return { type: "avatar", agent: agent ?? "broker", muted: false };
  }
  // failed-refunded and system rows are muted; non-plan rows (sweeps) get a
  // neutral dot — never a wrong agent's mark.
  return agent === null ? { type: "dot" } : { type: "avatar", agent, muted: true };
}

// ---------------------------------------------------------------------------
// Aggregate legs (sweep today; kill legs render through this in module 13)
// ---------------------------------------------------------------------------

const LEG_OUTCOME_LABELS: Record<string, string> = {
  finished: "Done",
  refunded: "Returned",
  failed: "Didn't complete",
  unverified: "Unverified",
};

/** Honest per-leg status word; unknown outcomes render verbatim (never hidden). */
export function legOutcomeLabel(outcome: string): string {
  return LEG_OUTCOME_LABELS[outcome] ?? outcome;
}

/** Leg fee text honoring the feeSource honesty flag (module 06): settled =
 *  exact, quoted = "~" prefix (ConfirmSheet's register), none/absent = null
 *  (the fee line is absent, not zeroed). */
export function legFeeText(leg: LegDetail): string | null {
  if (!leg.fees || leg.feeSource === "none") return null;
  const amount = receiptUsd(leg.fees.total);
  return leg.feeSource === "quoted" ? `~${amount}` : amount;
}

// ---------------------------------------------------------------------------
// Policy link quote — "because you set: $25.00 every week" quotes the plan's
// C3 terms line (lib/policy-terms is the ONLY term source; guardrail 6).
// ---------------------------------------------------------------------------

export interface PolicyQuoteSource {
  kind: FeedAgent;
  params: Record<string, unknown>;
}

/** The plan's C3 terms (RosterCard's exact mapping) — used by the policy-link
 *  sheet on S4. Malformed params yield [] rather than a wrong rendering. */
export function planTerms(plan: PolicyQuoteSource): PolicyTerm[] {
  try {
    return plan.kind === "broker"
      ? brokerTerms(plan.params as unknown as BrokerSection, {
          capPerPeriodUsd: plan.params.capPerPeriodUsd as number | undefined,
        })
      : plan.kind === "guardian"
        ? guardianTerms(plan.params as unknown as GuardianSection)
        : legacyTerms(plan.params as unknown as LegacySection);
  } catch {
    return [];
  }
}

/** "because you set: $25.00 every week" quotes the first valued term. */
export function policyQuote(plan: PolicyQuoteSource): string | null {
  const first = planTerms(plan).find((t) => t.value !== undefined);
  return first?.value ?? null;
}
