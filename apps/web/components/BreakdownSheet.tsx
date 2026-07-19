"use client";

import { networkName } from "@retenix/shared";

import { useNamedSource } from "@/hooks/use-named-source";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { fmtPct, fmtUsd } from "@/lib/format";
import type { AccountSummary } from "@/server/lib/summary";

/*
 * The breakdown sheet (doc 06, DS §7 C1/C2) — THE ONLY PLACE NETWORKS ARE EVER
 * NAMED, as provenance, never choice (PS-F2.4). There is no "pay from X"
 * affordance here or anywhere: these rows explain where an aggregate already
 * sits, after the fact. Opened by tapping the hero (C1) or the pill (C2);
 * both show the same sheet.
 *
 * Bottom sheet per doc 01: ui/sheet defaults to side="bottom" with top radius
 * xl, max-h dvh-safe, safe-area padding, reduced-motion fade.
 */

type Summary = Pick<AccountSummary, "buyingPowerUsd" | "sources" | "assets">;

/** Minimal geometric network mark — monogram on a muted disc (no brand-logo
 *  assets in v1; consistent with the avatar system's geometric language). */
const NETWORK_MONOGRAMS: Record<number, string> = {
  1: "E",
  8453: "B",
  42161: "A",
  56: "BN",
  196: "X",
  101: "S",
};

function NetworkMark({ chainId }: { chainId: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[0.625rem] font-medium text-muted-foreground"
    >
      {NETWORK_MONOGRAMS[chainId] ?? "·"}
    </span>
  );
}

export function BreakdownSheet({
  open,
  onOpenChange,
  summary,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: Summary;
}) {
  const { buyingPowerUsd, sources, assets } = summary;
  // PS-8.2: the Sources list names networks. Gated on `open` because this
  // component is mounted unconditionally by BuyingPowerHeader, and on
  // sources so an empty breakdown (which renders "Nothing funded yet")
  // reports nothing.
  useNamedSource("breakdown", open && sources.length !== 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader className="pb-0">
          <SheetTitle>Buying power</SheetTitle>
          <SheetDescription>
            <span className="tnum">{fmtUsd(buyingPowerUsd)}</span> — where it
            comes from.
          </SheetDescription>
        </SheetHeader>

        {sources.length === 0 ? (
          <p className="px-4 pb-4 text-small text-muted-foreground">
            Nothing funded yet. Money you add appears here, wherever it arrives.
          </p>
        ) : (
          <div className="flex flex-col gap-6 px-4 pb-4">
            <section aria-labelledby="breakdown-sources-heading">
              <h3
                id="breakdown-sources-heading"
                className="pb-2 text-caption text-muted-foreground"
              >
                Sources
              </h3>
              <ul className="flex flex-col">
                {sources.map((s) => (
                  <li
                    key={s.chainId}
                    className="flex items-center gap-3 border-b border-border py-3 last:border-b-0"
                  >
                    <NetworkMark chainId={s.chainId} />
                    <span className="flex-1 text-body">{s.name}</span>
                    <span className="tnum text-body">{fmtUsd(s.usd)}</span>
                    <span className="tnum w-16 text-right text-small text-muted-foreground">
                      {fmtPct(s.pct)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-labelledby="breakdown-assets-heading">
              <h3
                id="breakdown-assets-heading"
                className="pb-2 text-caption text-muted-foreground"
              >
                Assets
              </h3>
              <ul className="flex flex-col">
                {assets.map((a) => (
                  <li
                    key={a.symbol}
                    className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0"
                  >
                    <span className="flex items-baseline justify-between">
                      <span className="text-body">{a.symbol}</span>
                      <span className="tnum text-body">{fmtUsd(a.usd)}</span>
                    </span>
                    <span className="tnum text-caption text-muted-foreground">
                      {a.perChain
                        .map((c) => `${networkName(c.chainId)} ${fmtUsd(c.usd)}`)
                        .join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
