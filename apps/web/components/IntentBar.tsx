"use client";

// C5 · IntentBar (doc 10 task 3) — utterance in, draft cards out. Fixed above
// the tab bar on S3. On parse: draft PolicyCards render with the fixed
// confidence line + Proceed / Edit / Discard. Parse failure: doc 09's decline
// payload, verbatim — escalation over hallucination, never a stack trace.
//
// The advice footer (PS-10.7) rides on model-proposed baskets only, from the
// route's adviceFooter flag.
import { useMemo, useState } from "react";
import type {
  BrokerSection,
  GuardianSection,
  LegacySection,
  PolicyDraft,
} from "@retenix/shared";
import { PolicyCard } from "@/components/PolicyCard";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { AutonomyDial } from "@/components/AutonomyDial";
import { Button } from "@/components/ui/button";
import {
  brokerAllocation,
  brokerTerms,
  guardianTerms,
  legacyTerms,
} from "@/lib/policy-terms";
import { buildActivateInput, signCreatePlan } from "@/lib/activation-client";
import { fmtUsd } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { trpcVanilla } from "@/lib/trpc-vanilla";
import type { Autonomy } from "@retenix/shared";

// Placeholder rotates the PS-F3.2 canonical utterance + two shorter ones.
const PLACEHOLDERS = [
  "Invest $25 every week: 60% SPYx, 30% TSLAx, 10% SOL. Stop if I'm down 15%.",
  "Put $100 a month into QQQx.",
  "Cap me at $200 a week.",
];

interface ParsedDraft {
  draftId: string;
  draft: PolicyDraft;
  adviceFooter: boolean;
}
interface Decline {
  message: string;
  suggestions: string[];
}

export function IntentBar({
  eoa,
  onActivated,
}: {
  eoa: string;
  onActivated: () => void;
}) {
  const [text, setText] = useState("");
  const [placeholderIdx] = useState(() =>
    // deterministic per mount (no Math.random in render); varies by clock tick.
    Math.floor(Date.now() / 4000) % PLACEHOLDERS.length,
  );
  const [parsed, setParsed] = useState<ParsedDraft | null>(null);
  const [decline, setDecline] = useState<Decline | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parse = trpc.intent.parse.useMutation();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || parse.isPending) return;
    setDecline(null);
    setParsed(null);
    try {
      const res = await parse.mutateAsync({ text: text.trim() });
      if (res.ok) {
        setParsed({
          draftId: res.draftId,
          draft: res.draft,
          adviceFooter: res.adviceFooter,
        });
      } else {
        setDecline(res.decline);
      }
    } catch {
      setDecline({
        message:
          "Drafting isn't available right now. Try again in a moment — or build it by hand.",
        suggestions: [],
      });
    }
  }

  function discard() {
    setParsed(null);
    setDecline(null);
    setText("");
    setError(null);
  }

  if (parsed) {
    return (
      <DraftReview
        parsed={parsed}
        confirming={confirming}
        busy={busy}
        error={error}
        onProceed={() => {
          setError(null);
          setConfirming(true);
        }}
        onCancelConfirm={() => setConfirming(false)}
        onDiscard={discard}
        onActivate={async (accept, autonomy) => {
          setBusy(true);
          setError(null);
          try {
            // 1. Server preview: exact onchain terms + the digest to sign.
            const prep = await trpcVanilla.plans.prepareActivation.query({
              draftId: parsed.draftId,
              accept,
            });
            // 2. Owner signs the createPlan digest (if a plan is created).
            const createPlanAuth = prep.createPlan
              ? await signCreatePlan(
                  prep.createPlan.digest,
                  prep.createPlan.nonce,
                  eoa,
                )
              : undefined;
            // 3. Submit the signed activation.
            const input = await buildActivateInput(
              { draftId: parsed.draftId, accept, autonomy, createPlanAuth },
              eoa,
            );
            await trpcVanilla.plans.activate.mutate(input);
            setConfirming(false);
            setParsed(null);
            setText("");
            onActivated();
          } catch (err) {
            setError(
              err instanceof Error
                ? err.message
                : "Something went wrong — nothing was activated.",
            );
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {decline && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-small text-foreground">{decline.message}</p>
          {decline.suggestions.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {decline.suggestions.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => setText(s)}
                    className="text-left text-caption text-agent"
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 500))}
          placeholder={PLACEHOLDERS[placeholderIdx]}
          rows={2}
          maxLength={500}
          aria-label="Describe an agent in your own words"
          className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" disabled={!text.trim() || parse.isPending}>
          {parse.isPending ? "Reading…" : "Draft it"}
        </Button>
      </form>
    </div>
  );
}

// The parsed-draft review: three draft cards + the confidence line + the C6
// confirmation. Broker+guardian accept together (one onchain plan); the user
// deselects a card by discarding (v1 keeps the flow one-tap for the demo).
function DraftReview({
  parsed,
  confirming,
  busy,
  error,
  onProceed,
  onCancelConfirm,
  onDiscard,
  onActivate,
}: {
  parsed: ParsedDraft;
  confirming: boolean;
  busy: boolean;
  error: string | null;
  onProceed: () => void;
  onCancelConfirm: () => void;
  onDiscard: () => void;
  onActivate: (
    accept: { broker: boolean; guardian: boolean; legacy: boolean },
    autonomy: Autonomy,
  ) => void;
}) {
  const [autonomy, setAutonomy] = useState<Autonomy>("auto");
  const { broker, guardian, legacy } = parsed.draft;
  const accept = useMemo(
    () => ({ broker: Boolean(broker), guardian: Boolean(guardian), legacy: Boolean(legacy) }),
    [broker, guardian, legacy],
  );

  const sentence = confirmSentence(broker, guardian, legacy);

  return (
    <div className="flex flex-col gap-3" data-testid="draft-review">
      <p className="text-small text-muted-foreground">
        Here&apos;s what I understood — check the numbers
      </p>

      {broker && (
        <PolicyCard
          kind="broker"
          state="draft"
          title="Broker"
          terms={brokerTerms(broker)}
          adviceFooter={parsed.adviceFooter}
        >
          <AllocationDetail broker={broker} />
          <div className="flex flex-col gap-1">
            <span className="text-caption text-muted-foreground">
              How much it may do on its own
            </span>
            <AutonomyDial value={autonomy} onChange={setAutonomy} name="draft-broker" />
          </div>
        </PolicyCard>
      )}
      {guardian && (
        <PolicyCard
          kind="guardian"
          state="draft"
          title="Guardian"
          terms={guardianTerms(guardian)}
        />
      )}
      {legacy && (
        <PolicyCard
          kind="legacy"
          state="draft"
          title="Continuity"
          terms={legacyTerms(legacy)}
        />
      )}

      <div className="flex gap-4">
        <Button type="button" onClick={onProceed}>
          Proceed
        </Button>
        <button
          type="button"
          onClick={onDiscard}
          className="min-h-6 text-small text-muted-foreground"
        >
          Discard
        </button>
      </div>

      <ConfirmSheet
        open={confirming}
        onOpenChange={(next) => !next && onCancelConfirm()}
        sentence={sentence}
        summary={
          broker
            ? `First run right away, then ${everyWord(broker.cadence)}.`
            : undefined
        }
        confirmLabel="Confirm"
        busy={busy}
        error={error}
        onConfirm={() => onActivate(accept, autonomy)}
      />
    </div>
  );
}

function AllocationDetail({ broker }: { broker: BrokerSection }) {
  const alloc = brokerAllocation(broker);
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-0.5 text-caption text-muted-foreground">
      {alloc.map((a) => (
        <li key={a.text}>
          {a.text} <span className="tnum">{a.value}</span>
        </li>
      ))}
    </ul>
  );
}

function everyWord(cadence: BrokerSection["cadence"]): string {
  return cadence === "daily" ? "every day" : cadence === "weekly" ? "every week" : "every month";
}

function confirmSentence(
  broker?: BrokerSection,
  guardian?: GuardianSection,
  legacy?: LegacySection,
): string {
  const parts: string[] = [];
  if (broker) {
    parts.push(`invest ${fmtUsd(broker.amountUsd)} ${everyWord(broker.cadence)}`);
  }
  if (guardian) {
    if (guardian.weeklyCapUsd !== undefined) {
      parts.push(`cap you at ${fmtUsd(guardian.weeklyCapUsd)} a week`);
    }
    if (guardian.maxDrawdownPct !== undefined) {
      parts.push(`stop at ${guardian.maxDrawdownPct}% down`);
    }
  }
  if (legacy) {
    parts.push(`hand everything to ${legacy.beneficiaryEmail} after ${legacy.inactivityDays} quiet days`);
  }
  const joined =
    parts.length <= 1
      ? parts[0] ?? "set this up"
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Hire your agents to ${joined}.`;
}
