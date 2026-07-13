"use client";

import { useEffect, useRef, useState } from "react";
import { SWEEP_PROMPT_THRESHOLD_USD, type SweepReceipt } from "@retenix/shared";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { Button } from "@/components/ui/button";
import { fmtUsd } from "@/lib/format";
import {
  resumePendingReport,
  runSweep,
  type SweepProgress,
} from "@/lib/sweep-runner";
import { trpc } from "@/lib/trpc";

/*
 * The first-session dust-sweep prompt (doc 06; S2 hosts it — the home shell
 * reserved this slot for doc 06). An OFFER, never an action: silence does
 * nothing, dismissal is remembered (events sweep.dismissed), and nothing is
 * ever auto-swept. Renders only when preview finds ≥ $1 (PROPOSED threshold)
 * and the user has neither swept nor dismissed.
 *
 * Canonical copy (CONFLICTS #9, decision surface): "We found $23.11 in
 * 5 places. Add it to your buying power? [One tap]" — amount/count live,
 * .tnum, never hardcoded (G3). The JSX below must compose to exactly the
 * sweepPromptCopy() string; e2e asserts it.
 *
 * One confirmation → the whole batch (PS-F2-AC2): the ConfirmSheet's single
 * confirm tap drives lib/sweep-runner (authorize → sequential headless legs →
 * report). Success feedback is the ceiling: the post-sweep receipt line + a
 * subtle check — no celebration (G15).
 */

// The sheet freezes the numbers the user confirmed — preview data refreshes
// underneath it (post-sweep it drops to zero) and must never mutate an open
// confirmation surface.
type Confirmed = { totalUsd: number; fees: { gas: number; service: number; lp: number; total: number } };

type FlowState =
  | { kind: "idle" }
  | { kind: "confirming"; confirmed: Confirmed }
  | { kind: "running"; confirmed: Confirmed; progress: SweepProgress }
  | { kind: "done"; confirmed: Confirmed; receipt: SweepReceipt }
  | { kind: "failed"; confirmed: Confirmed; message: string };

const OUTCOME_LABEL: Record<string, string> = {
  finished: "added",
  refunded: "returned",
  failed: "didn't complete",
  unverified: "still settling",
};

export function SweepPromptCard({ eoa }: { eoa: string }) {
  const utils = trpc.useUtils();
  const preview = trpc.sweep.preview.useQuery(undefined, {
    retry: false,
    staleTime: 30_000,
  });
  const dismiss = trpc.sweep.dismiss.useMutation({
    onSuccess: () => void utils.sweep.preview.invalidate(),
  });
  const [flow, setFlow] = useState<FlowState>({ kind: "idle" });
  const resumed = useRef(false);

  // A previous session may have executed legs without landing the report —
  // deliver it silently so the receipt is never lost.
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    void resumePendingReport(eoa)
      .then((receipt) => {
        if (receipt) {
          void utils.sweep.preview.invalidate();
          void utils.account.summary.invalidate();
        }
      })
      .catch(() => {
        /* the stash stays; a later mount retries */
      });
  }, [eoa, utils]);

  const sheetOpen = flow.kind !== "idle";

  if (preview.isPending || preview.error) return null;
  const { totalUsd, items, fees, hasSwept, dismissed } = preview.data;
  const placeCount = new Set(items.map((i) => i.chainId)).size;
  const eligible =
    !hasSwept && !dismissed && totalUsd >= SWEEP_PROMPT_THRESHOLD_USD;
  if (!eligible && flow.kind === "idle") return null;

  const startSweep = (confirmed: Confirmed) => {
    setFlow({ kind: "running", confirmed, progress: { stage: "authorizing" } });
    runSweep(eoa, (progress) => setFlow({ kind: "running", confirmed, progress }))
      .then((result) => {
        if (result.kind === "nothing") {
          setFlow({
            kind: "failed",
            confirmed,
            message: "Nothing left to add — it may have just been picked up.",
          });
          return;
        }
        setFlow({ kind: "done", confirmed, receipt: result.receipt });
        void utils.account.summary.invalidate();
        void utils.sweep.preview.invalidate();
      })
      .catch((err: unknown) => {
        const code = (err as { data?: { code?: string } }).data?.code;
        setFlow({
          kind: "failed",
          confirmed,
          message:
            code === "CONFLICT"
              ? "A sweep is already running — give it a moment, then try again."
              : "That didn't complete. Your money only moves when a step succeeds — try again.",
        });
      });
  };

  const failedLegs =
    flow.kind === "done"
      ? flow.receipt.legs.filter((l) => l.outcome !== "finished")
      : [];

  return (
    <>
      {eligible && (
        <section
          aria-label="Found money"
          className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-soft"
        >
          <p className="text-body">
            We found <span className="tnum">{fmtUsd(totalUsd)}</span> in{" "}
            <span className="tnum">{placeCount}</span>{" "}
            {placeCount === 1 ? "place" : "places"}. Add it to your buying
            power?
          </p>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={() =>
                setFlow({ kind: "confirming", confirmed: { totalUsd, fees } })
              }
            >
              One tap
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate()}
            >
              Not now
            </Button>
          </div>
        </section>
      )}

      <ConfirmSheet
        open={sheetOpen}
        onOpenChange={(open) => {
          if (!open) setFlow({ kind: "idle" });
        }}
        sentence={`Add ${fmtUsd(
          flow.kind === "idle" ? totalUsd : flow.confirmed.totalUsd,
        )} to your buying power?`}
        fees={flow.kind === "idle" ? fees : flow.confirmed.fees}
        summary="Everything scattered becomes buying power in your account."
        confirmLabel="Confirm"
        onConfirm={() =>
          startSweep(
            flow.kind === "idle" ? { totalUsd, fees } : flow.confirmed,
          )
        }
        busy={flow.kind === "running"}
        done={flow.kind === "done"}
        error={flow.kind === "failed" ? flow.message : null}
      >
        {flow.kind === "running" && (
          <p aria-live="polite" className="text-small text-muted-foreground">
            {flow.progress.stage === "executing" ? (
              <>
                Adding{" "}
                <span className="tnum">
                  {flow.progress.done + 1} of {flow.progress.total}
                </span>
                …
              </>
            ) : flow.progress.stage === "settling" ? (
              "Settling…"
            ) : flow.progress.stage === "reporting" ? (
              "Saving your receipt…"
            ) : (
              "Checking what's there…"
            )}
          </p>
        )}

        {flow.kind === "done" && (
          <div className="flex flex-col gap-3" aria-live="polite">
            <p className="flex items-center gap-2 text-body">
              {/* The subtle check IS the ceiling of success feedback (G15). */}
              <span aria-hidden="true" className="text-agent">
                ✓
              </span>
              <span className="tnum">{flow.receipt.headline}</span>
            </p>
            <ul className="flex flex-col gap-1">
              {flow.receipt.legs.map((leg) => (
                <li
                  key={`${leg.chainId}:${leg.token}`}
                  className="flex items-baseline justify-between gap-3 text-small"
                >
                  {/* copy-canon-allow — receipt context: networks may be named */}
                  <span className="text-muted-foreground">
                    {leg.network} · {leg.symbol}
                  </span>
                  <span className="tnum">
                    {fmtUsd(leg.usd)}{" "}
                    <span className="text-muted-foreground">
                      {OUTCOME_LABEL[leg.outcome] ?? leg.outcome}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            {failedLegs.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() =>
                  flow.kind === "done" && startSweep(flow.confirmed)
                }
              >
                Try the rest again
              </Button>
            )}
          </div>
        )}
      </ConfirmSheet>
    </>
  );
}
