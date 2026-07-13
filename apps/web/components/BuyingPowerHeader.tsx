"use client";

import { useState, useSyncExternalStore } from "react";
import { BreakdownSheet } from "@/components/BreakdownSheet";
import { HeroMoney } from "@/components/HeroMoney";
import { BalanceSkeleton } from "@/components/skeletons";
import { SourcePill } from "@/components/SourcePill";
import { Button } from "@/components/ui/button";
import { useCountUp } from "@/hooks/use-count-up";
import { trpc } from "@/lib/trpc";
import type { AccountSummary } from "@/server/lib/summary";

/*
 * C1 BuyingPowerHeader (DS §7, doc 06) — the money moment. States: skeleton /
 * loaded (count-up 400ms, once per session) / stale (amber dot + "as of Nm
 * ago", wired off asOf > 120s). Tapping the amount or the pill opens the
 * breakdown sheet — provenance, never choice. The amount announces politely
 * (aria-live inside HeroMoney), never assertively.
 *
 * Failure honesty: account.summary serves last-known-with-old-asOf when the
 * balance source is down (the stale dot renders), and errors only when there
 * is no truth to show — that branch renders the unavailable state + retry,
 * never a spinner over money, never an invented number.
 */

/** C1 renders the stale dot once the summary is older than this (doc 06). */
const STALE_AFTER_MS = 120_000;

// Render must not read the wall clock (react-hooks/purity), so the clock is
// subscribed to as the external system it is — minute-grain snapshots, checked
// every 30s: exactly the resolution "as of Nm ago" can express. The server
// snapshot pins age at 0 ("fresh"), which is also what an unsampled first
// paint should claim.
const MINUTE_MS = 60_000;
const subscribeClock = (onChange: () => void) => {
  const id = setInterval(onChange, 30_000);
  return () => clearInterval(id);
};
const readClockMinute = () => Math.floor(Date.now() / MINUTE_MS);
const readClockMinuteServer = () => 0;

function LoadedHero({ summary }: { summary: AccountSummary }) {
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const display = useCountUp(summary.buyingPowerUsd, {
    sessionKey: "buying-power",
  });
  const nowMinute = useSyncExternalStore(
    subscribeClock,
    readClockMinute,
    readClockMinuteServer,
  );
  const asOfMs = Date.parse(summary.asOf);
  const ageMs = Number.isNaN(asOfMs)
    ? 0
    : Math.max(0, nowMinute * MINUTE_MS - asOfMs);
  const stale = ageMs > STALE_AFTER_MS;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-caption text-muted-foreground">Buying power</p>
      <button
        type="button"
        aria-haspopup="dialog"
        className="w-fit rounded-lg text-left"
        onClick={() => setBreakdownOpen(true)}
      >
        <HeroMoney value={display} live />
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <SourcePill
          count={summary.sources.length}
          onClick={() => setBreakdownOpen(true)}
        />
        {stale && (
          <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-warning"
            />
            as of <span className="tnum">{Math.round(ageMs / 60_000)}</span>m
            ago
          </span>
        )}
      </div>
      <BreakdownSheet
        open={breakdownOpen}
        onOpenChange={setBreakdownOpen}
        summary={summary}
      />
    </div>
  );
}

export function BuyingPowerHeader() {
  const summary = trpc.account.summary.useQuery(undefined, {
    retry: false,
    staleTime: 30_000,
  });

  if (summary.isPending) return <BalanceSkeleton />;

  if (summary.error) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-caption text-muted-foreground">Buying power</p>
        <p className="text-body text-muted-foreground">
          We can&rsquo;t show your balance right now. Your money is untouched —
          this screen is the only thing affected.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => void summary.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }

  return <LoadedHero summary={summary.data} />;
}
