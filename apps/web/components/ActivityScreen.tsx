"use client";

// S4 · Activity (doc 11) — the staff's ledger: header + pause chip → filter
// chips (All / Trades / Blocked / System) → virtualized feed with client-
// computed day dividers → infinite scroll. Loading = FeedSkeleton; empty =
// etching + "Your staff's work shows up here." (PROPOSED). The feed is calm:
// receipts slide in (250ms), nothing pops, nothing celebrates (G15).
//
// Virtualization: useWindowVirtualizer — the app shell scrolls the DOCUMENT
// (main + fixed TabBar), so an inner scroll container would break the shell
// feel. The <ul> itself is the sizer (ul>li stays valid for the axe list
// rule); rows are absolute-positioned <li>s with stable keys so measurements
// survive index shifts when the poll prepends. The entrance animation lives
// on an INNER wrapper (ReceiptRow) — never the positioned <li>.
//
// WCAG 2.2.2: the pause chip stops the poll AND freezes the shared clock that
// relative timestamps and day labels render from; state is announced through
// an always-mounted polite status region.
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildFeedRows, type FeedItem, type FeedRow } from "@retenix/shared";
import { Pause, Play } from "lucide-react";
import { PolicyCard, type PolicyCardState } from "@/components/PolicyCard";
import { ReceiptRow } from "@/components/ReceiptRow";
import { FeedSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useFeed } from "@/hooks/use-feed";
import { planTerms, policyQuote } from "@/lib/feed-view";
import { trpc } from "@/lib/trpc";
import type { FeedFilter } from "@/server/routers/activity";

/** plans.list card, with jsonb params normalized off the wire's `unknown`. */
interface RosterCard {
  planId: string;
  kind: "broker" | "guardian" | "legacy";
  status: "draft" | "active" | "paused" | "revoked";
  params: Record<string, unknown>;
}

const FILTERS: { value: FeedFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "trades", label: "Trades" },
  { value: "blocked", label: "Blocked" },
  { value: "system", label: "System" },
];

// Row-height estimates for the virtualizer (measured sizes take over
// immediately via measureElement's ResizeObserver).
const RECEIPT_EST = 76;
const DIVIDER_EST = 36;
const LOADER_EST = 48;

export function ActivityScreen() {
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [policyPlanId, setPolicyPlanId] = useState<string | null>(null);
  const feed = useFeed({ filter });

  const rows = useMemo(
    () => buildFeedRows(feed.items, feed.nowMs),
    [feed.items, feed.nowMs],
  );

  // The roster powers the "because you set: …" links and the C3 card sheet.
  // Revoked plans are absent from plans.list — their receipts simply omit the
  // link (graceful degradation for revoke-and-recreate histories).
  const roster = trpc.plans.list.useQuery();
  const planById = useMemo(() => {
    const map = new Map<string, RosterCard>();
    for (const card of roster.data?.cards ?? []) {
      map.set(card.planId, {
        planId: card.planId,
        kind: card.kind,
        status: card.status,
        params: (card.params ?? {}) as Record<string, unknown>,
      });
    }
    return map;
  }, [roster.data]);
  const policyPlan = policyPlanId ? planById.get(policyPlanId) : undefined;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-4 pb-8">
        <header className="flex items-start justify-between gap-3 pt-4">
          <div>
            <h1 className="text-display font-display">Activity</h1>
            <p className="text-small text-muted-foreground">
              Everything your staff did, in plain English.
            </p>
          </div>
          <button
            type="button"
            aria-pressed={feed.paused}
            onClick={feed.togglePaused}
            className="mt-2 flex min-h-6 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1 text-small text-muted-foreground transition-micro hover:text-foreground"
          >
            {feed.paused ? (
              <Play size={16} strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <Pause size={16} strokeWidth={1.5} aria-hidden="true" />
            )}
            Pause updates
          </button>
          {/* always-mounted so screen readers track the region (2.2.2) */}
          <span role="status" className="sr-only">
            {feed.paused ? "Updates paused" : ""}
          </span>
        </header>

        <FilterChips value={filter} onChange={setFilter} />

        {feed.isPending ? (
          <FeedSkeleton />
        ) : feed.isError ? (
          <div className="flex flex-col gap-3 pt-4">
            <p className="text-body text-muted-foreground">
              We can&rsquo;t show your activity right now. Your money is
              untouched — this screen is the only thing affected.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={feed.refetch}
            >
              Try again
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState />
        ) : (
          <FeedList
            rows={rows}
            nowMs={feed.nowMs}
            newIds={feed.newIds}
            hasNextPage={feed.hasNextPage}
            isFetchingNextPage={feed.isFetchingNextPage}
            fetchNextPage={feed.fetchNextPage}
            expandedId={expandedId}
            onToggle={(id) => setExpandedId((c) => (c === id ? null : id))}
            quoteFor={(item) => {
              const plan = item.detail?.planId
                ? planById.get(item.detail.planId)
                : undefined;
              return plan ? (policyQuote(plan) ?? undefined) : undefined;
            }}
            onOpenPolicy={(item) =>
              setPolicyPlanId(item.detail?.planId ?? null)
            }
          />
        )}
      </div>

      <Sheet
        open={policyPlan !== undefined}
        onOpenChange={(next) => !next && setPolicyPlanId(null)}
      >
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>The rule behind this</SheetTitle>
            <SheetDescription>
              What you signed — readable, pausable, revocable on the Agents
              screen.
            </SheetDescription>
          </SheetHeader>
          {policyPlan && (
            <div className="px-4 pb-4">
              <PolicyCard
                kind={policyPlan.kind}
                state={policyPlan.status as PolicyCardState}
                title={
                  policyPlan.kind === "broker"
                    ? "Broker"
                    : policyPlan.kind === "guardian"
                      ? "Guardian"
                      : "Continuity"
                }
                terms={planTerms(policyPlan)}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Filter chips — native radios inside pill labels (AutonomyDial's pattern:
// the browser owns the arrow-key semantics), single-select, ≥24px targets.
// ---------------------------------------------------------------------------

function FilterChips({
  value,
  onChange,
}: {
  value: FeedFilter;
  onChange: (next: FeedFilter) => void;
}) {
  return (
    <fieldset
      role="radiogroup"
      aria-label="Filter activity"
      className="flex flex-wrap gap-2"
    >
      {FILTERS.map((f) => {
        const checked = value === f.value;
        return (
          <label
            key={f.value}
            className={`flex min-h-6 cursor-pointer items-center rounded-full border px-3 py-1 text-small transition-micro has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${
              checked
                ? "border-transparent bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            <input
              type="radio"
              name="activity-filter"
              value={f.value}
              checked={checked}
              onChange={() => onChange(f.value)}
              className="sr-only"
            />
            {f.label}
          </label>
        );
      })}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// The virtualized feed
// ---------------------------------------------------------------------------

function FeedList({
  rows,
  nowMs,
  newIds,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  expandedId,
  onToggle,
  quoteFor,
  onOpenPolicy,
}: {
  rows: FeedRow[];
  nowMs: number;
  newIds: ReadonlySet<string>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  expandedId: string | null;
  onToggle: (id: string) => void;
  quoteFor: (item: FeedItem) => string | undefined;
  onOpenPolicy: (item: FeedItem) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const [listOffset, setListOffset] = useState(0);
  useLayoutEffect(() => {
    setListOffset(listRef.current?.offsetTop ?? 0);
  }, []);

  const count = rows.length + (hasNextPage ? 1 : 0); // +1 = loader row
  const virtualizer = useWindowVirtualizer({
    count,
    estimateSize: (i) =>
      rows[i] === undefined
        ? LOADER_EST
        : rows[i].kind === "divider"
          ? DIVIDER_EST
          : RECEIPT_EST,
    overscan: 8,
    scrollMargin: listOffset,
    getItemKey: (i) => rows[i]?.key ?? "__loader",
  });
  const vItems = virtualizer.getVirtualItems();

  // Infinite scroll: the loader row entered the window.
  const lastIndex = vItems[vItems.length - 1]?.index ?? -1;
  useEffect(() => {
    if (lastIndex >= rows.length && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [lastIndex, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Prepend compensation: the virtualizer does not adjust for INSERTIONS
  // (only for measured size changes of existing keys), so when the poll
  // prepends rows while the user is scrolled into the feed, shift the
  // viewport by the inserted estimate — content stays put and the new rows
  // wait above. At the top, do nothing: new receipts push down and slide in.
  // While paused the poll is off, so a paused reader is never jumped.
  const prevKeysRef = useRef<Set<string | number> | null>(null);
  useLayoutEffect(() => {
    const prevKeys = prevKeysRef.current;
    prevKeysRef.current = new Set(rows.map((r) => r.key));
    if (prevKeys === null || rows.length === 0) return;
    const anchorIdx = rows.findIndex(
      (r) => r.kind === "receipt" && prevKeys.has(r.key),
    );
    if (anchorIdx <= 0) return; // nothing new above the previous head
    const inserted = rows
      .slice(0, anchorIdx)
      .filter((r) => !prevKeys.has(r.key));
    if (inserted.length === 0) return;
    const estimate = inserted.reduce(
      (sum, r) => sum + (r.kind === "divider" ? DIVIDER_EST : RECEIPT_EST),
      0,
    );
    if (window.scrollY > listOffset) window.scrollBy(0, estimate);
  }, [rows, listOffset]);

  return (
    <ul
      ref={listRef}
      aria-label="Activity feed"
      className="relative m-0 list-none p-0"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {vItems.map((vi) => {
        const row = rows[vi.index];
        return (
          <li
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            className="absolute inset-x-0 top-0"
            style={{
              transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
            }}
          >
            {row === undefined ? (
              <p
                aria-hidden="true"
                className="py-3 text-center text-caption text-muted-foreground"
              >
                …
              </p>
            ) : row.kind === "divider" ? (
              <h2 className="pb-1 pt-4 text-caption font-medium uppercase tracking-wide text-muted-foreground">
                {row.label}
              </h2>
            ) : (
              <ReceiptRow
                item={row.item}
                nowMs={nowMs}
                isNew={newIds.has(row.item.id)}
                expanded={expandedId === row.item.id}
                onToggle={() => onToggle(row.item.id)}
                policyQuote={quoteFor(row.item)}
                onOpenPolicy={
                  row.item.detail?.planId
                    ? () => onOpenPolicy(row.item)
                    : undefined
                }
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Empty state — thin-line etching, single-color ink (doc 01 §illustration)
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <svg
        aria-hidden="true"
        width="72"
        height="72"
        viewBox="0 0 72 72"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="text-muted-foreground/50"
      >
        {/* a ledger page, etched */}
        <path d="M20 10h32v50l-5-4-5 4-6-4-6 4-5-4-5 4V10Z" />
        <path d="M27 22h18M27 30h18M27 38h10" />
        <circle cx="45" cy="40" r="2" fill="currentColor" stroke="none" />
      </svg>
      <p className="text-body text-muted-foreground">
        Your staff&apos;s work shows up here.
      </p>
    </div>
  );
}
