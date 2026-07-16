"use client";

// useFeed (doc 11 task 5) — the S4 poll-with-pause data hook:
//   - infinite cursor pagination over activity.feed (30/page server-side);
//     (at,id) keyset cursors are prepend-stable, so react-query's sequential
//     all-pages interval refetch stays contiguous and duplicate-free;
//   - poll every 20s while visible (PROPOSED — W3 review); react-query only
//     ticks focused tabs (refetchIntervalInBackground defaults false), so a
//     hidden tab polls nothing;
//   - pause (WCAG 2.2.2): stops the poll AND freezes the clock relative
//     timestamps render from — every auto-updating figure stops together;
//   - new-arrival detection for the 250ms slide-in: head-page id diff,
//     time-bounded so virtualizer re-mounts never replay the entrance.
import { useCallback, useEffect, useState } from "react";
import type { FeedItem } from "@retenix/shared";
import { useNowMinute } from "@/hooks/use-now-minute";
import { trpc } from "@/lib/trpc";
import type { FeedFilter } from "@/server/routers/activity";

const POLL_MS = 20_000; // PROPOSED (doc 11) — W3 design review
const NEW_IDS_TTL_MS = 600; // animation is 250ms; expire the flag well after
const EMPTY_SET: ReadonlySet<string> = new Set();

interface SeenHead {
  filter: FeedFilter;
  ids: Set<string>;
  newIds: ReadonlySet<string>;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export interface UseFeedResult {
  items: FeedItem[];
  /** Ids that just arrived via the poll — drive animate-receipt-in once. */
  newIds: ReadonlySet<string>;
  paused: boolean;
  togglePaused: () => void;
  /** Minute-grain clock, frozen while paused — the ONLY time source rows use. */
  nowMs: number;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

export function useFeed({ filter }: { filter: FeedFilter }): UseFeedResult {
  const [paused, setPaused] = useState(false);
  const [frozenAtMs, setFrozenAtMs] = useState(0);

  const query = trpc.activity.feed.useInfiniteQuery(
    { filter },
    {
      getNextPageParam: (last) => last.nextCursor,
      refetchInterval: paused ? false : POLL_MS,
    },
  );

  const liveNowMs = useNowMinute();
  const nowMs = paused ? frozenAtMs : liveNowMs;

  const togglePaused = useCallback(() => {
    // Date.now() is read in the event handler, never in render (purity rule);
    // the captured instant is what paused rows keep rendering from.
    setFrozenAtMs(Date.now());
    setPaused((p) => !p);
  }, []);

  // New-arrival detection via the sanctioned adjust-state-during-render
  // pattern (react-hooks/set-state-in-effect forbids synchronous setState in
  // effects): compare the head page's ids against the last-seen set and
  // record what arrived. A filter switch resets the baseline (a cached filter
  // remounting must not animate everything); the initial load never animates.
  const [seen, setSeen] = useState<SeenHead | null>(null);
  const headItems = query.data?.pages[0]?.items;
  if (headItems) {
    const sameFilter = seen?.filter === filter;
    const ids = new Set(headItems.map((i) => i.id));
    if (!sameFilter || !setsEqual(seen.ids, ids)) {
      const arrived =
        sameFilter && seen
          ? headItems.filter((i) => !seen.ids.has(i.id)).map((i) => i.id)
          : [];
      setSeen({ filter, ids, newIds: new Set(arrived) });
    }
  }
  const newIds = seen?.filter === filter ? seen.newIds : EMPTY_SET;

  // Expire the arrival flags AFTER the entrance played (async setState from a
  // timer is fine) — virtualizer re-mounts must never replay the slide-in.
  useEffect(() => {
    if (newIds.size === 0) return;
    const t = setTimeout(
      () =>
        setSeen((s) =>
          s && s.newIds.size > 0 ? { ...s, newIds: EMPTY_SET } : s,
        ),
      NEW_IDS_TTL_MS,
    );
    return () => clearTimeout(t);
  }, [newIds]);

  return {
    items: query.data?.pages.flatMap((p) => p.items) ?? [],
    newIds,
    paused,
    togglePaused,
    nowMs,
    isPending: query.isPending,
    isError: query.isError,
    refetch: () => void query.refetch(),
    fetchNextPage: () => void query.fetchNextPage(),
    hasNextPage: query.hasNextPage ?? false,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}
