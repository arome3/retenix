"use client";

import Link from "next/link";
import { useState } from "react";
import { AllocationRing } from "@/components/AllocationRing";
import { AssetDetailSheet } from "@/components/AssetDetailSheet";
import { HoldingRow } from "@/components/HoldingRow";
import { PortfolioChart } from "@/components/PortfolioChart";
import {
  ChartSkeleton,
  HoldingsSkeleton,
  RingSkeleton,
} from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { Num } from "@/components/Num";
import { fmtUsd } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { ringSegments, type ChartRange } from "@retenix/shared";

// S2's portfolio body (doc 12): C11 chart → C9 ring → C10 holdings list.
// One holdings query feeds the ring, the rows, the chart's live point and
// the dev reconciliation banner; the chart re-queries snapshots per range.
// Ring placement between chart and list is PROPOSED (the spec's assembly
// line omits C9; its DoD reads "chart + ring + holdings").

export function PortfolioSection() {
  const holdings = trpc.portfolio.holdings.useQuery(undefined, {
    retry: false,
    staleTime: 30_000,
  });
  const [range, setRange] = useState<ChartRange>("1m");
  const chart = trpc.portfolio.chart.useQuery(
    { range },
    { retry: false, staleTime: 30_000 },
  );
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);

  if (holdings.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <ChartSkeleton />
        <RingSkeleton />
        <HoldingsSkeleton />
      </div>
    );
  }

  // Honest unavailable state + retry — never a fabricated number (doc 06's
  // C1 failure pattern; the route already served last-known if it had one).
  if (holdings.isError) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-6 shadow-soft">
        <p className="text-body">Your portfolio is unavailable right now.</p>
        <p className="text-small text-muted-foreground">
          Nothing is lost — this screen only shows numbers it can stand behind.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void holdings.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }

  const data = holdings.data;

  if (data.holdings.length === 0) {
    return <EmptyPortfolio />;
  }

  const openHolding =
    data.holdings.find((h) => h.assetId === openAssetId) ?? null;
  const livePoint = {
    t: Math.floor(Date.parse(data.asOf) / 1000),
    usd: data.totalUsd,
  };
  const chartLast = [...(chart.data?.points ?? []), livePoint]
    .map((p) => ("usd" in p ? p.usd : null))
    .filter((v): v is number => v !== null)
    .at(-1);

  return (
    <div className="flex flex-col gap-6">
      <PortfolioChart
        points={chart.data?.points ?? []}
        livePoint={livePoint}
        range={range}
        onRangeChange={setRange}
        isPending={chart.isPending}
      />

      <AllocationRing
        segments={ringSegments(data.holdings)}
        totalUsd={data.totalUsd}
      />

      <ul aria-label="Holdings" className="flex flex-col gap-3">
        {data.holdings.map((holding) => (
          <li key={holding.assetId}>
            <HoldingRow
              holding={holding}
              onOpen={() => setOpenAssetId(holding.assetId)}
            />
          </li>
        ))}
      </ul>

      {process.env.NODE_ENV !== "production" ? ( // eslint-disable-line no-restricted-properties -- build-time constant, dev-only banner (app/dev precedent)
        <ReconcileDevCheck
          rowsSum={data.holdings.reduce((s, h) => s + h.valueUsd, 0)}
          ringCenter={data.totalUsd}
          chartLast={chartLast}
          unattributedBuys={data.unattributedBuys}
        />
      ) : null}

      <AssetDetailSheet
        holding={openHolding}
        onOpenChange={(open) => {
          if (!open) setOpenAssetId(null);
        }}
      />
    </div>
  );
}

// Empty portfolio (doc 12, PROPOSED copy verbatim): etching + one line +
// a single CTA to S3 — exactly one focusable, the a11y-shell tab budget
// counts on it.
function EmptyPortfolio() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-card p-8 text-center shadow-soft">
      <svg
        aria-hidden="true"
        viewBox="0 0 96 64"
        className="h-16 w-24 text-muted-foreground/50"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        {/* etched statement page: frame, a value line rising, a ring mark */}
        <rect x="6" y="4" width="84" height="56" rx="4" />
        <path d="M14 44 L34 36 L50 40 L66 26 L82 20" />
        <circle cx="24" cy="18" r="7" />
        <path d="M24 11 A7 7 0 0 1 31 18" strokeWidth="2.5" />
        <path d="M40 14 H70 M40 19 H60" strokeWidth="1" />
      </svg>
      <p className="text-body">Your first plan funds this page.</p>
      <Button asChild variant="outline">
        <Link href="/agents">Set up a plan</Link>
      </Button>
    </div>
  );
}

// Dev-only reconciliation check (doc 12 step 7): Σ holdings.valueUsd vs the
// ring center vs the chart's last point, asserted within rounding — catches
// basis/mark drift the moment it appears. 404-class dev surface: this
// component never renders in production builds.
function ReconcileDevCheck({
  rowsSum,
  ringCenter,
  chartLast,
  unattributedBuys,
}: {
  rowsSum: number;
  ringCenter: number;
  chartLast: number | undefined;
  unattributedBuys: number;
}) {
  const tolerance = 0.01 * Math.max(2, Math.round(rowsSum / 100));
  const drift = Math.max(
    Math.abs(rowsSum - ringCenter),
    chartLast === undefined ? 0 : Math.abs(chartLast - ringCenter),
  );
  const ok = drift <= tolerance;
  return (
    <p
      data-reconcile={ok ? "ok" : "drift"}
      className={`rounded-md border px-3 py-2 text-caption ${
        ok
          ? "border-border text-muted-foreground"
          : "border-warning text-warning"
      }`}
    >
      dev · reconcile {ok ? "✓" : "⚠"} rows{" "}
      <Num>{fmtUsd(rowsSum)}</Num> · ring <Num>{fmtUsd(ringCenter)}</Num> ·
      chart <Num>{chartLast === undefined ? "—" : fmtUsd(chartLast)}</Num>
      {unattributedBuys > 0 ? (
        <>
          {" · "}
          <span className="text-warning">
            {unattributedBuys} unattributed trade
            {unattributedBuys === 1 ? "" : "s"} — basis suppressed
          </span>
        </>
      ) : null}
    </p>
  );
}
