"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AreaData,
  IChartApi,
  ISeriesApi,
  Time,
  UTCTimestamp,
  WhitespaceData,
} from "lightweight-charts";
import { Num } from "@/components/Num";
import { ChartSkeleton } from "@/components/skeletons";
import { absTime, fmtDelta, fmtPct, fmtUsd } from "@/lib/format";
import { useThemePrefs } from "@/lib/theme";
import type { ChartPoint, ChartRange } from "@retenix/shared";

// C11 · PortfolioChart (doc 12, DS §7): lightweight-charts v5 area chart —
// the ONLY chart dependency (DS-11.2), dynamic-imported client-only. The
// line is TEAL, not gain-colored (G14); the CVD theme touches only the
// delta caption below. `attributionLogo` is NEVER passed: the default-on
// TradingView logo is an Apache-2.0 NOTICE requirement, not a style choice.
// Snapshot holes arrive as usd:null points and render as whitespace gaps —
// this chart interpolates nothing. No candles in v1: a brokerage statement,
// not a terminal.

const RANGES: { value: ChartRange; label: string; spoken: string }[] = [
  { value: "1w", label: "1W", spoken: "1 week" },
  { value: "1m", label: "1M", spoken: "1 month" },
  { value: "3m", label: "3M", spoken: "3 months" },
  { value: "all", label: "All", spoken: "all time" },
];

export interface PortfolioChartProps {
  points: ChartPoint[];
  /** The statement's live total — appended as the freshest point so the
   *  chart's last value reconciles with the ring center and holdings sum. */
  livePoint?: { t: number; usd: number } | null;
  range: ChartRange;
  onRangeChange: (range: ChartRange) => void;
  isPending?: boolean;
}

function token(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

export function PortfolioChart({
  points,
  livePoint,
  range,
  onRangeChange,
  isPending,
}: PortfolioChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const [ready, setReady] = useState(false);
  const [readout, setReadout] = useState<{ t: number; usd: number } | null>(null);
  const { mode } = useThemePrefs();

  const data = useMemo<(AreaData<Time> | WhitespaceData<Time>)[]>(() => {
    const mapped = points.map((p) =>
      p.usd === null
        ? { time: p.t as UTCTimestamp }
        : { time: p.t as UTCTimestamp, value: p.usd },
    );
    const last = points.at(-1);
    if (livePoint && (!last || livePoint.t > last.t)) {
      mapped.push({ time: livePoint.t as UTCTimestamp, value: livePoint.usd });
    }
    return mapped;
  }, [points, livePoint]);

  // Range delta (first → last stated value) — the one gain/loss surface here.
  const delta = useMemo(() => {
    const stated = data.filter(
      (d): d is AreaData<Time> => "value" in d && typeof d.value === "number",
    );
    if (stated.length < 2) return null;
    const first = stated[0].value;
    const lastV = stated[stated.length - 1].value;
    if (first <= 0) return null;
    return { usd: lastV - first, pct: ((lastV - first) / first) * 100 };
  }, [data]);

  // Init (and re-init on theme-mode change: colors are read from live CSS
  // tokens at construction). Effect-scoped dynamic import keeps the ~12 KB
  // canvas engine out of the first paint; StrictMode-safe via the cancel
  // flag + chart.remove() cleanup.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    let chart: IChartApi | null = null;

    void (async () => {
      const { createChart, AreaSeries } = await import("lightweight-charts");
      if (cancelled) return;

      const teal = token("--primary");
      chart = createChart(el, {
        autoSize: true,
        layout: {
          background: { color: "transparent" },
          textColor: token("--muted-foreground"),
          // attributionLogo deliberately untouched — default ON (NOTICE).
        },
        grid: {
          vertLines: { visible: false },
          horzLines: { visible: false },
        },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false },
        handleScroll: false,
        handleScale: false,
      });
      const series = chart.addSeries(AreaSeries, {
        lineColor: teal,
        // graphite-toned gradient off the teal token (doc 01) — sits on card.
        topColor: `color-mix(in oklab, ${teal} 24%, transparent)`,
        bottomColor: "transparent",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: true,
      });
      chart.subscribeCrosshairMove((param) => {
        const d = param.seriesData.get(series);
        if (d && "value" in d && typeof param.time === "number") {
          setReadout({ t: param.time, usd: d.value as number });
        } else {
          setReadout(null);
        }
      });

      chartRef.current = chart;
      seriesRef.current = series;
      setReady(true);
    })();

    return () => {
      cancelled = true;
      setReady(false);
      seriesRef.current = null;
      chartRef.current = null;
      chart?.remove();
    };
  }, [mode]);

  useEffect(() => {
    if (!ready || !seriesRef.current || !chartRef.current) return;
    seriesRef.current.setData(data);
    chartRef.current.timeScale().fitContent();
  }, [ready, data]);

  if (isPending) return <ChartSkeleton />;

  const spoken = RANGES.find((r) => r.value === range)?.spoken ?? range;
  const deltaSpoken =
    delta === null
      ? ""
      : `, ${delta.usd >= 0 ? "up" : "down"} ${fmtPct(Math.abs(delta.pct))}`;
  const empty = data.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <fieldset
        role="radiogroup"
        aria-label="Chart range"
        className="flex flex-wrap gap-2"
      >
        {RANGES.map((r) => {
          const checked = range === r.value;
          return (
            <label
              key={r.value}
              className={`flex min-h-6 cursor-pointer items-center rounded-full border px-3 py-1 text-small transition-micro has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${
                checked
                  ? "border-transparent bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              <input
                type="radio"
                name="chart-range"
                value={r.value}
                checked={checked}
                onChange={() => onRangeChange(r.value)}
                className="sr-only"
              />
              {r.label}
            </label>
          );
        })}
      </fieldset>

      <div
        role="img"
        aria-label={`Portfolio value${deltaSpoken} over ${spoken}`}
        className="relative"
      >
        <div ref={containerRef} className="h-44 w-full" aria-hidden="true" />
        {empty ? (
          <p className="absolute inset-0 grid place-items-center text-small text-muted-foreground">
            Portfolio history appears within an hour.
          </p>
        ) : null}
      </div>

      <div className="flex min-h-5 items-baseline justify-between gap-4 text-caption">
        {delta !== null ? (
          <Num
            className={delta.usd >= 0 ? "text-positive" : "text-negative"}
          >
            {fmtDelta(delta.usd, delta.pct)}
          </Num>
        ) : (
          <span aria-hidden="true" />
        )}
        {readout !== null ? (
          <span className="text-muted-foreground">
            <Num>{fmtUsd(readout.usd)}</Num>
            {" · "}
            <Num>{absTime(new Date(readout.t * 1000))}</Num>
          </span>
        ) : null}
      </div>
    </div>
  );
}
