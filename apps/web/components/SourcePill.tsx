"use client";

import { cn } from "@/lib/utils";

/*
 * C2 SourcePill (DS §7): "funded from 4 sources", rounded-full, muted; count =
 * networks with USD > 0, always live (1–6, never hardcoded — G3). Tapping
 * expands the breakdown sheet, the only place networks are ever named. Never
 * renders in decision flows — receipts and breakdowns only.
 */
export function SourcePill({
  count,
  onClick,
  className,
}: {
  count: number;
  onClick?: () => void;
  className?: string;
}) {
  if (count < 1) return null;
  const label = (
    <>
      funded from <span className="tnum">{count}</span>{" "}
      {count === 1 ? "source" : "sources"}
    </>
  );
  const base =
    "w-fit rounded-full bg-muted px-3 py-1 text-caption text-muted-foreground";

  if (!onClick) {
    return <span className={cn(base, className)}>{label}</span>;
  }
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={onClick}
      // px/py padding keeps the target ≥24px tall (DS-10 2.5.8).
      className={cn(base, "min-h-6 transition-micro hover:bg-accent", className)}
    >
      {label}
    </button>
  );
}
