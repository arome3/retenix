"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Num } from "@/components/Num";
import { fmtUsd } from "@/lib/format";
import { trpc } from "@/lib/trpc";

// Top-up prompt card (doc 12 renders what doc 08 emitted — PROPOSED
// placement: between the sweep prompt and the portfolio). Calm and factual:
// a skipped buy already has its receipt in the feed; this card only says why
// and where to look. Dismissal is per-session (sessionStorage, PROPOSED) —
// the next skip event is a new prompt.

const DISMISS_KEY = "retenix:topup-dismissed";

const listeners = new Set<() => void>();
function readDismissed(): string {
  try {
    return sessionStorage.getItem(DISMISS_KEY) ?? "";
  } catch {
    return ""; // private mode — the card simply stays visible this session
  }
}
function dismiss(at: string): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, at);
  } catch {
    /* private mode */
  }
  listeners.forEach((l) => l());
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function TopUpPromptCard() {
  const prompt = trpc.portfolio.topUpPrompt.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const dismissedAt = useSyncExternalStore(subscribe, readDismissed, () => "");

  const data = prompt.data;
  if (!data || dismissedAt === data.at) return null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-soft">
      <p className="text-body">
        A scheduled buy was skipped
        {data.shortUsd !== null ? (
          <>
            {" — buying power was "}
            <Num>{fmtUsd(data.shortUsd)}</Num>
            {" short"}
          </>
        ) : null}
        . Add funds and the plan picks back up on its own.
      </p>
      <div className="flex gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href="/activity">See the receipt</Link>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => dismiss(data.at)}
        >
          Not now
        </Button>
      </div>
    </div>
  );
}
