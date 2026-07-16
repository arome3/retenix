// Pure view logic for C10 (doc 12) — UI logic lives in plain functions
// proven in vitest, components stay thin (repo convention, lib/feed-view.ts).

import { fmtDelta, fmtPct, fmtUsd } from "@/lib/format";
import type { PortfolioHolding } from "@retenix/shared";

type DeltaSlice = Pick<PortfolioHolding, "deltaUsd" | "deltaPct">;

/** The signed delta line (`▲ +$12.40 (+2.15%)`) — null when basis is
 *  unknowable, so the row prints "—" and never a guessed return. */
export function holdingDeltaText(h: DeltaSlice): string | null {
  if (h.deltaUsd === null || h.deltaPct === null) return null;
  return fmtDelta(h.deltaUsd, h.deltaPct);
}

/** G14: gain/loss tokens touch ONLY this delta text — .cvd swaps them. */
export function holdingDeltaClass(h: DeltaSlice): string {
  return (h.deltaUsd ?? 0) >= 0 ? "text-positive" : "text-negative";
}

/** Full-sentence accessible name for the row button (doc 12 a11y). Contains
 *  the rendered strings (ticker, name, value) so the visible text stays part
 *  of the accessible name (WCAG 2.5.3). */
export function holdingAriaLabel(
  h: Pick<
    PortfolioHolding,
    "ticker" | "name" | "valueUsd" | "deltaUsd" | "deltaPct" | "markStale"
  >,
): string {
  const parts = [`${h.ticker}, ${h.name} — worth ${fmtUsd(h.valueUsd)}`];
  if (h.deltaUsd !== null && h.deltaPct !== null) {
    const word = h.deltaUsd >= 0 ? "up" : "down";
    parts.push(
      `${word} ${fmtUsd(Math.abs(h.deltaUsd))} (${fmtPct(Math.abs(h.deltaPct))}) since purchase`,
    );
  } else {
    parts.push("return unavailable");
  }
  if (h.markStale) parts.push("price may be out of date");
  return `${parts.join(", ")}. Opens details.`;
}
