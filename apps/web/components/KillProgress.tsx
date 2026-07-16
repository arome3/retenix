"use client";

import Link from "next/link";
import { useState } from "react";
import { Num } from "@/components/Num";
import { fmtUsd } from "@/lib/format";
import { retryKillLeg } from "@/lib/kill-runner";
import { trpc } from "@/lib/trpc";

/*
 * C7's per-leg progress list + calm completion state (doc 13). Polls
 * kill.status every second while legs are in flight; the list is a live
 * region (aria-live="polite", DS-10.8/doc 13 a11y). Retry chips re-arm ONE
 * leg (kill.retryLeg — headless envelope), retryable forever without
 * re-arming the hold.
 *
 * Completion is a sanctioned safety milestone (DS-1.4/G15): the calm copy,
 * no fireworks. Anything enumeration skipped is listed — continue-and-report,
 * never silent.
 */

// PROPOSED completion copy, implemented verbatim as documented (doc 13).
const COMPLETION_COPY = "Everything is USDC. Your staff is dismissed.";

const OUTCOME_LABELS: Record<string, string> = {
  pending: "Waiting",
  submitted: "Sent",
  settled: "Done",
  failed: "Didn't complete",
  refunded: "Returned",
  unverified: "Unverified",
};

const RETRYABLE = new Set(["failed", "refunded", "unverified"]);

// State dots stay in destructive-foreground opacities (teal on crimson fails
// 1.4.11 at 2.81 — see contrast.ts); the label next to each dot is the real
// encoder (1.4.1: color never the sole channel).
function outcomeDot(outcome: string): string {
  if (outcome === "settled") return "bg-destructive-foreground";
  if (RETRYABLE.has(outcome)) return "bg-destructive-foreground/70";
  return "bg-destructive-foreground/40";
}

export function KillProgress({ eoa, killId }: { eoa: string; killId: string }) {
  const utils = trpc.useUtils();
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const status = trpc.kill.status.useQuery(
    { killId },
    {
      refetchInterval: (query) => (query.state.data?.done ? false : 1_000),
      refetchIntervalInBackground: false,
    },
  );

  // The dust teaser renders only after completion, and only when the scan
  // succeeds — the kill surface never depends on it (graceful degradation).
  const dust = trpc.sweep.preview.useQuery(undefined, {
    enabled: status.data?.done === true,
    retry: false,
  });

  if (status.isPending) {
    return (
      <p role="status" className="text-small opacity-80">
        Loading…
      </p>
    );
  }
  if (status.isError || !status.data) {
    return (
      <p role="alert" className="text-small">
        Couldn&apos;t load progress — it continues in the background. Pull to
        refresh or come back in a moment.
      </p>
    );
  }

  const s = status.data;

  const retry = (legId: string) => {
    setRetrying((prev) => new Set(prev).add(legId));
    void retryKillLeg(eoa, killId, legId)
      .catch(() => {
        // The row's honest state (still failed, or "already completed") shows
        // on the next poll — nothing silent either way.
      })
      .finally(() => {
        setRetrying((prev) => {
          const next = new Set(prev);
          next.delete(legId);
          return next;
        });
        void utils.kill.status.invalidate();
      });
  };

  const revokeLine =
    s.revoke.state === "confirmed"
      ? "All agents revoked."
      : s.revoke.state === "submitted"
        ? "All agents lose authority — confirming…"
        : s.revoke.state === "failed"
          ? "Agent revocation didn't go through — it will be retried."
          : "Removing agent authority…";

  return (
    <div className="space-y-8">
      <p role="status" aria-live="polite" className="text-small font-medium">
        {revokeLine}
      </p>

      {s.legs.length > 0 ? (
        <ul aria-live="polite" className="space-y-3">
          {s.legs.map((leg) => (
            <li key={leg.legId} className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className={`size-2 shrink-0 rounded-full ${outcomeDot(leg.outcome)}`}
              />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{leg.symbol}</span>{" "}
                {/* copy-canon-allow — leg rows may name networks (receipt context) */}
                <span className="text-caption opacity-70">{leg.network}</span>
              </span>
              {leg.usdEst !== null ? (
                <Num className="text-small opacity-90">{fmtUsd(leg.usd ?? leg.usdEst)}</Num>
              ) : (
                <span className="text-small opacity-60">—</span>
              )}
              <span className="w-28 text-right text-caption opacity-80">
                {OUTCOME_LABELS[leg.outcome] ?? leg.outcome}
              </span>
              {RETRYABLE.has(leg.outcome) ? (
                <button
                  type="button"
                  onClick={() => retry(leg.legId)}
                  disabled={retrying.has(leg.legId)}
                  className="rounded-full border border-destructive-foreground/40 px-3 py-1 text-caption font-medium disabled:opacity-50"
                >
                  {retrying.has(leg.legId) ? "Retrying…" : "Retry"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {s.done ? (
        <div className="space-y-4 border-t border-destructive-foreground/20 pt-6">
          <p className="text-body font-medium">{COMPLETION_COPY}</p>
          {s.receipt ? <p className="text-small opacity-80">{s.receipt}</p> : null}

          {s.skipped.length > 0 ? (
            <div className="text-caption opacity-80">
              <p>Left as-is (too small to liquidate):</p>
              <ul className="mt-1 space-y-0.5">
                {s.skipped.map((skip, i) => (
                  <li key={`${skip.symbol}-${i}`}>
                    {skip.symbol}
                    {skip.usd !== undefined ? (
                      <>
                        {" · "}
                        <Num>{fmtUsd(skip.usd)}</Num>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {dust.data && dust.data.totalUsd > 0 ? (
            <p className="text-caption opacity-80">
              We also found <Num>{fmtUsd(dust.data.totalUsd)}</Num> in small
              balances — the sweep on Home can add it to your buying power.
            </p>
          ) : null}

          <Link href="/home" className="inline-block underline underline-offset-4">
            Back to Home
          </Link>
        </div>
      ) : null}
    </div>
  );
}
