"use client";

import { useSyncExternalStore } from "react";
import { HeroMoney } from "@/components/HeroMoney";
import { BalanceSkeleton } from "@/components/skeletons";
import { SourcePill } from "@/components/SourcePill";
import { Button } from "@/components/ui/button";
import { useCountUp } from "@/hooks/use-count-up";
import { trpc } from "@/lib/trpc";

/*
 * C1 BuyingPowerHeader — shell (DS §7 anatomy; doc 06 owns the data).
 *
 * account.summary still throws NOT_IMPLEMENTED, so today the query always
 * lands in the error branch: dev builds show preview numbers (devAffordances
 * is false in every production build, so an invented balance can never reach
 * a user), production shows the honest unavailable state. The skeleton /
 * loaded / stale rendering is real — doc 06 keeps it and swaps the data in.
 */

// The pill needs only the network count; doc 06's response is
// { totalUsd, sources[], asOf }. TODO(doc 06): use the router's inferred type.
type Summary = { totalUsd: number; sourceCount: number; asOf: number | null };

const PREVIEW: Summary = { totalUsd: 4812.07, sourceCount: 4, asOf: null };

/** C1 renders the stale dot once the quote is older than this (doc 06). */
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

function LoadedHero({
  summary,
  preview,
}: {
  summary: Summary;
  preview?: boolean;
}) {
  const display = useCountUp(summary.totalUsd, { sessionKey: "buying-power" });
  const nowMinute = useSyncExternalStore(
    subscribeClock,
    readClockMinute,
    readClockMinuteServer,
  );
  const ageMs =
    summary.asOf === null
      ? 0
      : Math.max(0, nowMinute * MINUTE_MS - summary.asOf);
  const stale = ageMs > STALE_AFTER_MS;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-caption text-muted-foreground">Buying power</p>
      <HeroMoney value={display} live />
      <div className="flex flex-wrap items-center gap-2">
        <SourcePill count={summary.sourceCount} />
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
      {preview && (
        <p className="text-caption text-muted-foreground">
          Preview numbers — module 06 wires real balances.
        </p>
      )}
    </div>
  );
}

export function BuyingPowerHeader({ devPreview }: { devPreview: boolean }) {
  const summary = trpc.account.summary.useQuery(undefined, {
    retry: false,
    staleTime: 30_000,
  });

  if (summary.isPending) return <BalanceSkeleton />;

  if (summary.error) {
    if (devPreview) return <LoadedHero summary={PREVIEW} preview />;
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

  // Live data (module 06 onward). The route throws today, so its output type
  // is `never` — this cast disappears with doc 06's real return type.
  const data = summary.data as unknown as {
    totalUsd: number;
    sources: unknown[];
    asOf: string;
  };
  return (
    <LoadedHero
      summary={{
        totalUsd: data.totalUsd,
        sourceCount: data.sources.length,
        asOf: new Date(data.asOf).getTime(),
      }}
    />
  );
}
