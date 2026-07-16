"use client";

import { useRouter } from "next/navigation";
import { Num } from "@/components/Num";
import { Sparkline } from "@/components/Sparkline";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { fmtUsd } from "@/lib/format";
import { holdingDeltaClass, holdingDeltaText } from "@/lib/portfolio-view";
import type { PortfolioHolding } from "@retenix/shared";

// C10's asset detail sheet (doc 12): a bigger slice of the position's
// history, the position stats, THE DISCLOSURE LINE — persistent, not
// dismissible, pinned above the actions (PS-F8.3/PS-10.3) — and the
// actions themselves. This is a decision surface (G12): plain vocabulary
// only; the registry's disclosure string is the mandated exception.
//
// Buy more prefills the intent bar on the Agents screen (PROPOSED wording,
// recorded in HANDOFF). Sell arrives behind the doc-12 feature flag in a
// follow-up commit — the sheet's contract already reserves its slot.

export interface AssetDetailSheetProps {
  holding: PortfolioHolding | null;
  onOpenChange: (open: boolean) => void;
  /** Rendered into the actions row when the sell flow is enabled (flag). */
  sellAction?: React.ReactNode;
}

function StatRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-small text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

export function AssetDetailSheet({
  holding,
  onOpenChange,
  sellAction,
}: AssetDetailSheetProps) {
  const router = useRouter();
  const delta = holding ? holdingDeltaText(holding) : null;

  return (
    <Sheet open={holding !== null} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined}>
        {holding ? (
          <div className="flex flex-col gap-4">
            <SheetHeader>
              <SheetTitle>{holding.ticker}</SheetTitle>
              <SheetDescription>{holding.name}</SheetDescription>
            </SheetHeader>

            {holding.spark.length >= 2 ? (
              <Sparkline
                points={holding.spark}
                className="h-20 w-full text-muted-foreground"
              />
            ) : null}

            <dl className="flex flex-col gap-2.5">
              <StatRow label="Quantity">
                <Num>{holding.qtyHuman ?? String(holding.qty)}</Num>
              </StatRow>
              <StatRow label="Price">
                <span className="inline-flex items-center gap-1.5">
                  {holding.markStale ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full bg-warning"
                      />
                      <span className="sr-only">price may be out of date —</span>
                    </>
                  ) : null}
                  <Num>{fmtUsd(holding.markUsd)}</Num>
                </span>
              </StatRow>
              <StatRow label="Value">
                <Num className="font-medium">{fmtUsd(holding.valueUsd)}</Num>
              </StatRow>
              <StatRow label="Cost basis">
                {holding.costBasisUsd !== null ? (
                  <Num>{fmtUsd(holding.costBasisUsd)}</Num>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </StatRow>
              <StatRow label="Return">
                {delta !== null ? (
                  <Num className={holdingDeltaClass(holding)}>{delta}</Num>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </StatRow>
            </dl>

            {/* The compliance line (registry data, rendered verbatim) —
                persistent, pinned above the actions, on every equity. */}
            {holding.disclosure ? (
              <p className="border-t border-border pt-3 text-caption leading-relaxed text-muted-foreground">
                {holding.disclosure}
              </p>
            ) : null}

            <div className="flex gap-2 pb-safe">
              <Button
                type="button"
                className="flex-1"
                onClick={() =>
                  router.push(
                    `/agents?prefill=${encodeURIComponent(
                      `Buy $25 of ${holding.ticker} every week`,
                    )}`,
                  )
                }
              >
                Buy more
              </Button>
              {sellAction}
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
