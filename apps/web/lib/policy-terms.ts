// Plain-terms rendering for C3 (doc 10 task 1) — the readable term list a
// policy card shows. Rendered from the VALIDATED draft/params, never from the
// utterance (guardrail 6, doc 09): the card quotes the user's words only in its
// title; every number here comes from the structured object.
import { REGISTRY } from "@retenix/registry";
import type {
  BrokerSection,
  GuardianSection,
  LegacySection,
} from "@retenix/shared";
import { fmtUsd } from "@/lib/format";

const ticker = (id: string) =>
  REGISTRY.find((a) => a.id === id)?.ticker ?? id.toUpperCase();

const EVERY: Record<BrokerSection["cadence"], string> = {
  daily: "every day",
  weekly: "every week",
  monthly: "every month",
};

/** A term is a label the UI renders with its number in `.tnum` (G13). */
export interface PolicyTerm {
  /** Leading plain text. */
  text: string;
  /** The mutable number, rendered tabular; omitted for text-only terms. */
  value?: string;
}

/** Broker terms: "Invests $25 every week · Only SPYx, TSLAx, SOL · Never more than $50/week". */
export function brokerTerms(
  broker: BrokerSection,
  caps?: { capPerPeriodUsd?: number },
): PolicyTerm[] {
  const tickers = broker.basket.map((l) => ticker(l.assetId)).join(", ");
  const terms: PolicyTerm[] = [
    { text: "Invests", value: `${fmtUsd(broker.amountUsd)} ${EVERY[broker.cadence]}` },
    { text: "Only", value: tickers },
  ];
  if (caps?.capPerPeriodUsd !== undefined) {
    terms.push({ text: "Never more than", value: `${fmtUsd(caps.capPerPeriodUsd)} a period` });
  }
  return terms;
}

/** The exact per-leg allocation, for the draft-review detail. */
export function brokerAllocation(broker: BrokerSection): PolicyTerm[] {
  return broker.basket.map((l) => ({
    text: ticker(l.assetId),
    value: `${l.pct}%`,
  }));
}

/** Guardian terms from its caps. */
export function guardianTerms(guardian: GuardianSection): PolicyTerm[] {
  const terms: PolicyTerm[] = [];
  if (guardian.weeklyCapUsd !== undefined) {
    terms.push({ text: "Caps spending at", value: `${fmtUsd(guardian.weeklyCapUsd)} a week` });
  }
  if (guardian.maxDrawdownPct !== undefined) {
    terms.push({ text: "Stops everything at", value: `${guardian.maxDrawdownPct}% down` });
  }
  return terms;
}

/** Legacy terms. */
export function legacyTerms(legacy: LegacySection): PolicyTerm[] {
  return [
    { text: "Everything goes to", value: legacy.beneficiaryEmail },
    { text: "After", value: `${legacy.inactivityDays} days of quiet` },
  ];
}
