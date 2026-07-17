"use client";

// C8 · CountdownBanner (doc 14, design system §7 — verbatim): amber
// full-width banner on EVERY (app) screen once the countdown is live —
// "Inheritance countdown active — 4d 12h until claim opens. I'm here
// [cancels]." Demo-scaled timers carry the "(demo: minutes)" tag honestly
// (TS-9.5). One "I'm here" tap sends the signed estate.checkIn; the single
// relayed call both bumps the heartbeat and cancels the countdown (the
// contract's veto-by-liveness) — the anti-hijack moment, PS-F7-AC2. The
// banner then confirms with the calm safety-milestone sentence and clears.
//
// Mounted next to <CountdownBannerSlot/> in the (app) layout and portalled
// into the slot by id (the slot's documented contract, doc 01). Polls
// estate.status — 5s while a countdown is live, gently otherwise.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { formatCountdown } from "@/lib/format";
import { signEnvelope } from "@/lib/sign";
import { trpc } from "@/lib/trpc";
import { useNowSecond } from "@/hooks/use-now-second";
import { useMounted } from "@/hooks/use-mounted";
import { COUNTDOWN_BANNER_SLOT_ID } from "./CountdownBannerSlot";
import { Num } from "./Num";

const CANCELLED_COPY = "Welcome back. The countdown is cancelled.";
const CLEAR_AFTER_MS = 6_000;

export function CountdownBanner({ eoa }: { eoa: string }) {
  const mounted = useMounted();
  const status = trpc.estate.status.useQuery(undefined, {
    refetchInterval: (query) => {
      const view = query.state.data?.view;
      if (!view) return 60_000; // not enrolled — stay quiet
      return view.status === "countdown" || view.status === "claimable" ? 5_000 : 30_000;
    },
    refetchOnWindowFocus: true,
  });
  const checkIn = trpc.estate.checkIn.useMutation();
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cancelled) return;
    const id = setTimeout(() => setCancelled(false), CLEAR_AFTER_MS);
    return () => clearTimeout(id);
  }, [cancelled]);

  const view = status.data?.view;
  const live = view !== null && view !== undefined
    && (view.status === "countdown" || view.status === "claimable");

  if (!mounted) return null;
  const slot = document.getElementById(COUNTDOWN_BANNER_SLOT_ID);
  if (!slot) return null;
  if (!live && !cancelled) return null;

  async function imHere() {
    setError(null);
    try {
      const envelope = await signEnvelope(
        "estate.checkIn",
        { source: "im-here" as const },
        eoa,
      );
      const res = await checkIn.mutateAsync(envelope);
      if (res.cancelledCountdown) setCancelled(true);
      await status.refetch();
    } catch {
      setError("That didn't go through — try again.");
    }
  }

  return createPortal(
    cancelled && !live ? (
      // the safety-milestone confirmation (G15: restrained — nothing celebrates)
      <div
        role="status"
        className="w-full bg-muted px-4 py-3 text-small text-foreground md:px-6"
        data-testid="countdown-banner-cancelled"
      >
        {CANCELLED_COPY}
      </div>
    ) : (
      <div
        role="status"
        className="w-full bg-warning px-4 py-3 md:px-6"
        data-testid="countdown-banner"
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-small text-warning-foreground">
            {view!.status === "countdown" && view!.claimReadyAt ? (
              <>
                Inheritance countdown active —{" "}
                <CountdownRemaining until={view!.claimReadyAt} /> until claim opens.
              </>
            ) : (
              <>Inheritance claim is open — checking in still cancels it.</>
            )}
            {view!.demoScaled ? (
              <span className="ml-1 opacity-80">(demo: minutes)</span>
            ) : null}
          </p>
          <button
            type="button"
            onClick={() => void imHere()}
            disabled={checkIn.isPending}
            className="min-h-6 shrink-0 rounded-md bg-warning-foreground/10 px-3 py-1.5 text-small font-medium text-warning-foreground transition-micro hover:bg-warning-foreground/20 disabled:opacity-60"
          >
            {checkIn.isPending ? "Checking in…" : "I’m here"}
          </button>
        </div>
        {error ? (
          <p className="mt-1 text-caption text-warning-foreground/90">{error}</p>
        ) : null}
      </div>
    ),
    slot,
  );
}

/** The ticking digits — isolated so only this node re-renders every second,
 *  and the 1s clock only runs while a countdown is on screen. */
function CountdownRemaining({ until }: { until: string }) {
  const now = useNowSecond();
  return <Num>{formatCountdown(Date.parse(until) - now)}</Num>;
}
