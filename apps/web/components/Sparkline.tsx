"use client";

import { cn } from "@/lib/utils";

// C10's sparkline (doc 12, DS §7): a hand-rolled 20-point SVG polyline,
// viewBox-normalized, MUTED stroke — gain/loss color belongs to the delta
// text only (G14), and the line never celebrates (G15). Decorative by
// design: aria-hidden, with fewer than 2 points it renders nothing (a
// one-point "trend" would be an invention).

const VIEW_W = 100;
const VIEW_H = 28;
const PAD = 2;

export interface SparklineProps {
  points: number[];
  className?: string;
}

export function Sparkline({ points, className }: SparklineProps) {
  if (points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min;
  const coords = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * VIEW_W;
      // Flat series draws the midline; otherwise normalize into the padded box.
      const y =
        span === 0
          ? VIEW_H / 2
          : VIEW_H - PAD - ((v - min) / span) * (VIEW_H - PAD * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      className={cn("h-7 w-24", className)}
    >
      <polyline
        points={coords}
        fill="none"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        className="stroke-muted-foreground/80"
      />
    </svg>
  );
}
