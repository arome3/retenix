"use client";

import { fmtPct, fmtUsd } from "@/lib/format";
import { Num } from "@/components/Num";
import { ringArcs, roundPctsTo100, type RingSegment } from "@retenix/shared";

// C9 · AllocationRing (doc 12, DS §7) — hand-rolled SVG donut: two circles +
// stroke-dasharray, zero dependency. Segments wear the teal-tinted NEUTRAL
// ramp (--alloc-1..5): allocation is not gain/loss, so no green/red ever
// touches it (G14). Adjacent-segment contrast ≥3:1 is CI-enforced in
// scripts/contrast.ts; segments are also identified by legend ORDER — the
// list below is the accessible structure (the SVG is aria-hidden), so color
// is never the sole channel.

// Literal class names so Tailwind's scanner sees them; index i = token i+1.
const SEGMENT_STROKES = [
  "stroke-alloc-1",
  "stroke-alloc-2",
  "stroke-alloc-3",
  "stroke-alloc-4",
  "stroke-alloc-5",
];
const SWATCH_FILLS = [
  "bg-alloc-1",
  "bg-alloc-2",
  "bg-alloc-3",
  "bg-alloc-4",
  "bg-alloc-5",
];

const BOX = 124;
const CENTER = BOX / 2;
const RADIUS = 48;
const STROKE_WIDTH = 14;

export interface AllocationRingProps {
  /** Largest-first segments (shared ringSegments caps them at 5 + "Other"). */
  segments: RingSegment[];
  totalUsd: number;
}

export function AllocationRing({ segments, totalUsd }: AllocationRingProps) {
  if (segments.length === 0 || totalUsd <= 0) return null;

  // One rounding pass feeds BOTH the arcs and the legend, so the drawn ring
  // and the printed percentages always agree and sum to exactly 100.00.
  const pcts = roundPctsTo100(segments.map((s) => s.valueUsd));
  const arcs = ringArcs(pcts, RADIUS);

  return (
    <div className="flex items-center gap-6">
      <div className="relative shrink-0">
        <svg
          aria-hidden="true"
          width={BOX}
          height={BOX}
          viewBox={`0 0 ${BOX} ${BOX}`}
        >
          {/* rotate −90° so segment 1 starts at 12 o'clock; caps stay butt
              (round caps would overlap neighboring segments). */}
          <g transform={`rotate(-90 ${CENTER} ${CENTER})`}>
            <circle
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE_WIDTH}
              className="stroke-muted"
            />
            {arcs.map((arc, i) => (
              <circle
                key={segments[i].assetId}
                cx={CENTER}
                cy={CENTER}
                r={RADIUS}
                fill="none"
                strokeWidth={STROKE_WIDTH}
                strokeLinecap="butt"
                strokeDasharray={arc.dasharray}
                strokeDashoffset={arc.dashoffset}
                className={SEGMENT_STROKES[i]}
              />
            ))}
          </g>
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <Num className="max-w-20 truncate text-center font-display text-h2 font-medium">
            {fmtUsd(totalUsd)}
          </Num>
        </div>
      </div>

      <ul aria-label="Allocation" className="min-w-0 flex-1 space-y-1.5">
        {segments.map((s, i) => (
          <li key={s.assetId} className="flex items-center gap-2 text-small">
            <span
              aria-hidden="true"
              className={`size-2.5 shrink-0 rounded-full border border-border ${SWATCH_FILLS[i]}`}
            />
            <span className="min-w-0 flex-1 truncate">{s.ticker}</span>
            <Num className="text-right text-muted-foreground">
              {fmtPct(pcts[i])}
            </Num>
          </li>
        ))}
      </ul>
    </div>
  );
}
