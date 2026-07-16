"use client";

import { Num } from "@/components/Num";
import { Sparkline } from "@/components/Sparkline";
import { fmtUsd } from "@/lib/format";
import {
  holdingAriaLabel,
  holdingDeltaClass,
  holdingDeltaText,
} from "@/lib/portfolio-view";
import type { PortfolioHolding } from "@retenix/shared";

// C10 · HoldingRow (doc 12, DS §7): monogram · ticker + name · muted
// sparkline · value + signed delta. The delta TEXT is the only surface in
// this component wearing gain/loss tokens (G14) — the .cvd class swaps them
// app-wide. Unknown basis renders "—", never a guess. The whole row is a
// button with a full-sentence accessible name; tapping opens the asset
// detail sheet.

export interface HoldingRowProps {
  holding: PortfolioHolding;
  onOpen: () => void;
}

export function HoldingRow({ holding, onOpen }: HoldingRowProps) {
  const delta = holdingDeltaText(holding);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={holdingAriaLabel(holding)}
      className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-4 text-left shadow-soft transition-micro hover:bg-accent focus-visible:bg-accent"
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[0.625rem] font-medium text-muted-foreground"
      >
        {holding.ticker.slice(0, 2).toUpperCase()}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium">
          {holding.ticker}
        </span>
        <span className="block truncate text-small text-muted-foreground">
          {holding.name}
        </span>
      </span>

      <Sparkline points={holding.spark} className="hidden shrink-0 sm:block" />

      <span className="flex shrink-0 flex-col items-end">
        <span className="flex items-center gap-1.5">
          {holding.markStale ? (
            // doc 01 stale pattern: the amber dot, never a spinner over money.
            <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
          ) : null}
          <Num className="text-body font-medium">{fmtUsd(holding.valueUsd)}</Num>
        </span>
        {delta !== null ? (
          <Num className={`text-caption ${holdingDeltaClass(holding)}`}>
            {delta}
          </Num>
        ) : (
          <span className="text-caption text-muted-foreground">—</span>
        )}
      </span>
    </button>
  );
}
