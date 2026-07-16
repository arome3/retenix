"use client";

import Link from "next/link";
import { useState } from "react";
import { ReceiptRow } from "@/components/ReceiptRow";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useNowMinute } from "@/hooks/use-now-minute";
import { trpc } from "@/lib/trpc";

// S2's mini-feed (doc 12): the last 3 receipts, rendered by module 11's C4
// row against module 11's route — nothing re-authored, nothing forked. No
// poll/pause machinery here (that's S4's job); "See all" hands off to the
// full feed. Renders NOTHING while empty or loading — the a11y-shell tab
// budget and the calm of a fresh Home both count on that.

export function MiniFeed() {
  const feed = trpc.activity.feed.useQuery(
    { filter: "all", limit: 3 },
    { retry: false, staleTime: 30_000 },
  );
  const nowMs = useNowMinute();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const items = feed.data?.items ?? [];
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="mini-feed-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="mini-feed-heading" className="font-display text-h1">
          Activity
        </h2>
        <Link
          href="/activity"
          className="text-small text-muted-foreground underline-offset-4 transition-micro hover:text-foreground hover:underline"
        >
          See all
        </Link>
      </div>
      <TooltipProvider delayDuration={200}>
        <ul aria-label="Recent activity" className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.id}>
              <ReceiptRow
                item={item}
                nowMs={nowMs}
                expanded={expandedId === item.id}
                onToggle={() =>
                  setExpandedId((cur) => (cur === item.id ? null : item.id))
                }
              />
            </li>
          ))}
        </ul>
      </TooltipProvider>
    </section>
  );
}
