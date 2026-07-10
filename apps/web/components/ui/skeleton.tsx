import { cn } from "@/lib/utils"

// Skeletons over spinners for anything content-shaped (§6) — see
// components/skeletons.tsx for the balance/feed shapes docs 06/11 consume.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
