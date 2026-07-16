"use client";

// S3 · Agents (doc 10 task 9) — the staff roster: three stacks by agent
// (Broker · Guardian · Continuity), each listing that agent's C3 cards or an
// empty-state prompt; C5 IntentBar fixed at the bottom. Card lifecycle actions
// (Pause / Resume / Revoke) are signed mutations; Edit re-opens the numbers.
import { useState } from "react";
import type {
  BrokerSection,
  GuardianSection,
  LegacySection,
} from "@retenix/shared";
import {
  BrokerAvatar,
  ContinuityAvatar,
  GuardianAvatar,
} from "@/components/avatars";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { IntentBar } from "@/components/IntentBar";
import { PolicyCard, type PolicyCardState } from "@/components/PolicyCard";
import { useBlockedFlash } from "@/hooks/use-blocked-flash";
import { personalSign, signEnvelope } from "@/lib/sign";
import { brokerTerms, guardianTerms, legacyTerms } from "@/lib/policy-terms";
import { trpc } from "@/lib/trpc";
import { trpcVanilla } from "@/lib/trpc-vanilla";

interface Card {
  planId: string;
  kind: "broker" | "guardian" | "legacy";
  status: "draft" | "active" | "paused" | "revoked";
  contractPlanId: number | null;
  params: Record<string, unknown>;
}

const STACKS: {
  kind: Card["kind"];
  title: string;
  Avatar: typeof BrokerAvatar;
  empty: string;
}[] = [
  { kind: "broker", title: "Broker", Avatar: BrokerAvatar, empty: "No plan yet. Describe one below to hire your Broker." },
  { kind: "guardian", title: "Guardian", Avatar: GuardianAvatar, empty: "No rules yet. Set a cap or a stop below." },
  { kind: "legacy", title: "Continuity", Avatar: ContinuityAvatar, empty: "No continuity plan yet." },
];

export function AgentsScreen({
  eoa,
  initialIntent,
}: {
  eoa: string;
  /** Doc 12's Buy-more prefill — passed through to the intent bar. */
  initialIntent?: string;
}) {
  const roster = trpc.plans.list.useQuery();
  const [revoking, setRevoking] = useState<Card | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cards = (roster.data?.cards ?? []) as Card[];
  const byKind = (kind: Card["kind"]) => cards.filter((c) => c.kind === kind);

  const refresh = () => roster.refetch();

  // C3 amber flash (doc 10 task 11 → doc 11 task 7): the feed's blocked
  // stream drives it now — useBlockedFlash polls activity.feed({filter:
  // "blocked"}) every 15s and reports plan ids blocked in the last 2 minutes;
  // the guardian is seen working.
  const blocks = useBlockedFlash();
  const flashed = new Set(blocks.planIds);

  async function pauseResume(card: Card, to: "pause" | "resume") {
    const envelope = await signEnvelope(`plans.${to}`, { planId: card.planId }, eoa);
    if (to === "pause") await trpcVanilla.plans.pause.mutate(envelope);
    else await trpcVanilla.plans.resume.mutate(envelope);
    await refresh();
  }

  // Active-card edit = revoke-and-recreate under one confirmation (doc 10
  // task 8): the owner signs both the revoke (nonce N) and the new createPlan
  // (nonce N+1); two receipts, one action.
  async function recreate(card: Card, amountUsd: number) {
    const params = card.params as {
      cadence: "daily" | "weekly" | "monthly";
      basket: { assetId: string; pct: number }[];
    };
    const editedBroker = { cadence: params.cadence, amountUsd, basket: params.basket };
    const prep = await trpcVanilla.plans.prepareRecreate.query({
      planId: card.planId,
      edits: { broker: editedBroker },
    });
    const revokeAuth = {
      nonce: prep.revoke.nonce,
      signature: await personalSign(prep.revoke.digest, eoa),
    };
    const createPlanAuth = {
      nonce: prep.createPlan.nonce,
      signature: await personalSign(prep.createPlan.digest, eoa),
    };
    const envelope = await signEnvelope(
      "plans.recreate",
      { planId: card.planId, edits: { broker: editedBroker }, revokeAuth, createPlanAuth },
      eoa,
    );
    await trpcVanilla.plans.recreate.mutate(envelope);
    await refresh();
  }

  async function doRevoke(card: Card) {
    setBusy(true);
    setError(null);
    try {
      // The server reads authNonces(owner) and builds the revoke digest; the
      // owner signs it, and the relay re-verifies before spending (doc 10
      // security — the signature covers the exact plan + nonce).
      const prep = await trpcVanilla.plans.prepareRevoke.query({
        planId: card.planId,
      });
      let revokeAuth: { nonce: string; signature: string } | undefined;
      if (prep.digest !== null) {
        const signature = await personalSign(prep.digest, eoa);
        revokeAuth = { nonce: prep.nonce, signature };
      }
      const envelope = await signEnvelope(
        "plans.revoke",
        { planId: card.planId, revokeAuth },
        eoa,
      );
      await trpcVanilla.plans.revoke.mutate(envelope);
      setRevoking(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't revoke — try again.");
    } finally {
      setBusy(false);
    }
  }

  function cardState(card: Card): PolicyCardState {
    if (card.status === "active" && flashed.has(card.planId)) return "blocked";
    return card.status === "revoked" ? "revoked" : (card.status as PolicyCardState);
  }

  return (
    <div className="flex flex-col gap-6 pb-40">
      <header className="pt-4">
        <h1 className="text-display font-display">Your agents</h1>
        <p className="text-small text-muted-foreground">
          The staff you&apos;ve hired — each one readable, pausable, revocable.
        </p>
      </header>

      {STACKS.map(({ kind, title, Avatar, empty }) => {
        const stack = byKind(kind);
        return (
          <section key={kind} className="flex flex-col gap-3" aria-label={`${title} agents`}>
            <div className="flex items-center gap-2">
              <Avatar size={32} />
              <h2 className="text-h2 font-display">{title}</h2>
            </div>
            {stack.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-small text-muted-foreground">
                {empty}
              </p>
            ) : (
              stack.map((card) => (
                <RosterCard
                  key={card.planId}
                  card={card}
                  state={cardState(card)}
                  onPause={() => pauseResume(card, "pause")}
                  onResume={() => pauseResume(card, "resume")}
                  onRevoke={() => setRevoking(card)}
                  onEditAmount={
                    card.kind === "broker" && card.status === "active"
                      ? (amt) => recreate(card, amt)
                      : undefined
                  }
                />
              ))
            )}
          </section>
        );
      })}

      <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 mx-auto max-w-[480px] border-t border-border bg-background/95 p-4 backdrop-blur">
        <IntentBar eoa={eoa} onActivated={refresh} initialText={initialIntent} />
      </div>

      <ConfirmSheet
        open={revoking !== null}
        onOpenChange={(next) => !next && setRevoking(null)}
        sentence={
          revoking ? `Revoke this ${revoking.kind}? It can no longer act.` : ""
        }
        summary="This zeroes its authority on the record — one confirmation."
        confirmLabel="Confirm"
        busy={busy}
        error={error}
        onConfirm={() => revoking && doRevoke(revoking)}
      />
    </div>
  );
}

function RosterCard({
  card,
  state,
  onPause,
  onResume,
  onRevoke,
  onEditAmount,
}: {
  card: Card;
  state: PolicyCardState;
  onPause: () => void;
  onResume: () => void;
  onRevoke: () => void;
  /** Active broker only: revoke-and-recreate at a new amount. */
  onEditAmount?: (amountUsd: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(() =>
    Number((card.params as { amountUsd?: number }).amountUsd ?? 0),
  );
  const [busy, setBusy] = useState(false);

  const terms =
    card.kind === "broker"
      ? brokerTerms(card.params as unknown as BrokerSection, {
          capPerPeriodUsd: card.params.capPerPeriodUsd as number | undefined,
        })
      : card.kind === "guardian"
        ? guardianTerms(card.params as unknown as GuardianSection)
        : legacyTerms(card.params as unknown as LegacySection);

  const title =
    card.kind === "broker" ? "Broker" : card.kind === "guardian" ? "Guardian" : "Continuity";

  return (
    <PolicyCard
      kind={card.kind}
      state={state}
      title={title}
      terms={terms}
      onPause={onPause}
      onResume={onResume}
      onRevoke={onRevoke}
      onEdit={onEditAmount ? () => setEditing((v) => !v) : undefined}
    >
      {onEditAmount && editing && (
        <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-2">
          <label className="flex items-center gap-2 text-small text-muted-foreground">
            Amount each run
            <input
              type="number"
              min={1}
              max={1000}
              step={1}
              value={amount}
              aria-label="Amount each run"
              onChange={(e) => setAmount(Math.max(1, Math.min(1000, Number(e.target.value) || 0)))}
              className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-foreground tnum"
            />
          </label>
          <p className="text-caption text-muted-foreground">
            Saving cancels this plan and starts a fresh one at the new amount —
            you&apos;ll see two receipts.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onEditAmount(amount);
                  setEditing(false);
                } finally {
                  setBusy(false);
                }
              }}
              className="min-h-6 text-small text-agent"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="min-h-6 text-small text-muted-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </PolicyCard>
  );
}
