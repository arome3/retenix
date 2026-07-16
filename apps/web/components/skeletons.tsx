import { Skeleton } from "@/components/ui/skeleton";

// Skeletons for anything content-shaped; spinners only for discrete
// submissions; never a full-screen spinner over money (§6). Docs 06 and 11
// swap these for the loaded hero/feed.

/** Hero-sized block matching the buying-power moment: caption line, serif
 *  display-xl amount, source pill line. */
export function BalanceSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading balance"
      className="flex flex-col gap-2"
    >
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-12 w-52 rounded-lg" />
      <Skeleton className="h-4 w-36 rounded-full" />
    </div>
  );
}

/** C11 silhouette: range chips line + the chart canvas block (doc 12). */
export function ChartSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading portfolio chart"
      className="flex flex-col gap-3"
    >
      <Skeleton className="h-7 w-56 rounded-full" />
      <Skeleton className="h-44 w-full rounded-lg" />
    </div>
  );
}

/** C9 silhouette: donut + legend rows (doc 12). */
export function RingSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading allocation"
      className="flex items-center gap-6"
    >
      <Skeleton className="size-[124px] shrink-0 rounded-full" />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
  );
}

/** C10 silhouette: three holding rows — monogram, ticker+name, value. */
export function HoldingsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading holdings"
      className="flex flex-col gap-3"
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-lg border border-border bg-card p-4"
        >
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
          <div className="flex flex-col items-end gap-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Three receipt-shaped rows: avatar, sentence, caption, right-aligned
 *  timestamp — the C4 silhouette. */
export function FeedSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading activity"
      className="flex flex-col gap-3"
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-lg border border-border bg-card p-4"
        >
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-3 w-10 shrink-0" />
        </div>
      ))}
    </div>
  );
}
