"use client";

// Feed-driven C3 blocked flash (doc 11 task 7) — replaces module 10's interim
// plans.recentBlocks poll (its comment said: "module 11's activity.feed takes
// it over — same planId shape"). Polls the feed's blocked stream and reports
// the plan ids blocked within the flash window; AgentsScreen pulses those
// cards amber — the guardian seen working.
import { trpc } from "@/lib/trpc";

const POLL_MS = 15_000; // the interim poll's cadence, preserved
const WINDOW_MS = 120_000; // ...and its 2-minute flash window

export function useBlockedFlash(): { planIds: string[] } {
  const q = trpc.activity.feed.useQuery(
    { filter: "blocked" },
    { refetchInterval: POLL_MS },
  );
  // Freshness is measured against the fetch instant (dataUpdatedAt — store
  // state, not a render-time wall-clock read; react-hooks/purity).
  const since = q.dataUpdatedAt - WINDOW_MS;
  const planIds = [
    ...new Set(
      (q.data?.items ?? [])
        .filter((i) => Date.parse(i.at) >= since)
        .flatMap((i) => (i.detail?.planId ? [i.detail.planId] : [])),
    ),
  ];
  return { planIds };
}
