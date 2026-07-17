"use client";

// S5 · Legacy (doc 14, design system §8): the enrollment wizard — beneficiary
// email → threshold → review card (C3 legacy variant with the "Can never"
// panel) → ONE confirmation (C6) that signs the enrollEstate digest and runs
// the headless tuple ceremony — and the enrolled state (heartbeat status +
// last check-in + "coverage refreshed"). Zero crypto vocabulary anywhere
// (G12); the Solana exclusion disclosure appears on the review AND the
// enrolled state, verbatim (PS-F7.5 — naming the 5 networks is allowed here:
// coverage context, not a decision).
import { useState } from "react";
import {
  beneficiaryHashFor,
  enrollEstateDigest,
  resolveInactivitySecs,
  type EstateStatusView,
} from "@retenix/shared";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { PolicyCard } from "@/components/PolicyCard";
import { Num } from "@/components/Num";
import { signEscrowTuples } from "@/lib/escrow";
import { relTime } from "@/lib/format";
import { legacyTerms } from "@/lib/policy-terms";
import { personalSign, signEnvelope } from "@/lib/sign";
import { trpc } from "@/lib/trpc";

// PS-F7.5 / TS-10.5 — verbatim intent (doc 14 §Enrollment step 5).
const SOLANA_DISCLOSURE =
  "Inheritance covers your assets on Ethereum, Base, Arbitrum, BSC and X Layer. " +
  "Assets on Solana aren't covered yet — that's on our roadmap.";

function randomSalt(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function LegacyScreen({ eoa }: { eoa: string }) {
  const status = trpc.estate.status.useQuery();

  return (
    <div className="flex flex-col gap-4 pt-6">
      <h1 className="font-display text-title text-foreground">Legacy</h1>
      {status.isLoading ? (
        <p className="text-small text-muted-foreground">Loading your plan…</p>
      ) : status.data?.enrolled && status.data.view ? (
        <EnrolledState view={status.data.view} />
      ) : (
        <EnrollWizard eoa={eoa} onEnrolled={() => void status.refetch()} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Enrolled state
// ---------------------------------------------------------------------------
function EnrolledState({ view }: { view: EstateStatusView }) {
  const lastCheckIn = view.lastCheckIn ? new Date(view.lastCheckIn) : null;
  const refreshed = view.coverageRefreshedAt ? new Date(view.coverageRefreshedAt) : null;
  const days = Math.round(view.inactivitySecs / 86_400);
  return (
    <section className="flex flex-col gap-3" aria-label="Inheritance plan">
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-body text-foreground">
          Your inheritance plan is in place.
        </p>
        <dl className="mt-3 flex flex-col gap-1.5 text-small">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Heartbeat</dt>
            <dd className="text-foreground">
              {view.status === "countdown" || view.status === "claimable"
                ? "Countdown running — check in to cancel"
                : "Current"}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Last check-in</dt>
            <dd className="text-foreground">
              {lastCheckIn ? relTime(lastCheckIn) : "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Opens for your beneficiary after</dt>
            <dd className="text-foreground">
              {view.demoScaled ? (
                <>
                  <Num>{Math.round(view.inactivitySecs / 60)}</Num> quiet minutes{" "}
                  <span className="text-muted-foreground">(demo: minutes)</span>
                </>
              ) : (
                <>
                  <Num>{days}</Num> quiet days
                </>
              )}
            </dd>
          </div>
          {refreshed ? (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Coverage refreshed</dt>
              <dd className="text-foreground">{relTime(refreshed)}</dd>
            </div>
          ) : null}
        </dl>
      </div>
      <p className="text-caption text-muted-foreground">{SOLANA_DISCLOSURE}</p>
      <p className="text-caption text-muted-foreground">
        Your everyday activity is the heartbeat — using your account keeps the
        plan current, and you can always press “I’m here” if a countdown ever
        starts.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------
type Step = "who" | "when" | "review";

function EnrollWizard({ eoa, onEnrolled }: { eoa: string; onEnrolled: () => void }) {
  const prep = trpc.estate.prepareEnroll.useQuery();
  const enroll = trpc.estate.enroll.useMutation();

  const [step, setStep] = useState<Step>("who");
  const [email, setEmail] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [days, setDays] = useState(180);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // module 10 deviation 9: a stashed legacy card pre-fills the wizard once
  const prefill = prep.data?.prefill;
  const [prefilled, setPrefilled] = useState(false);
  if (!prefilled && prefill && (prefill.beneficiaryEmail || prefill.inactivityDays)) {
    setPrefilled(true);
    if (prefill.beneficiaryEmail && !email) setEmail(prefill.beneficiaryEmail);
    if (prefill.inactivityDays) setDays(prefill.inactivityDays);
  }

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const daysOk = Number.isInteger(days) && days >= 30 && days <= 3650;
  const demo = prep.data?.demoMode ?? false;

  async function confirmEnroll(): Promise<void> {
    if (!prep.data) return;
    setBusy(true);
    setError(null);
    try {
      const salt = randomSalt();
      const { inactivitySecs } = resolveInactivitySecs(
        days,
        prep.data.demoMode,
        prep.data.demoInactivitySecs,
      );
      const beneficiaryHash = beneficiaryHashFor(email, salt);
      // the digest commits to exactly what the review card showed; the relay
      // re-derives and verifies before submitting (doc 07's relayed-auth)
      const digest = enrollEstateDigest(
        { chainId: prep.data.domain.chainId, contract: prep.data.domain.contract },
        {
          beneficiaryHash,
          inactivitySecs: BigInt(inactivitySecs),
          nonce: BigInt(prep.data.authNonce),
        },
      );
      const signature = await personalSign(digest, eoa);
      // the tuple ceremony — headless, sequential, one authorization per
      // covered network, each bound to the live account nonce (the dead-man
      // switch: any activity of yours voids them; login re-signs silently)
      const tuples = await signEscrowTuples(prep.data.targets);
      const payload = {
        beneficiaryEmail: email.trim(),
        ...(ownerName.trim() ? { ownerDisplayName: ownerName.trim() } : {}),
        inactivityDays: days,
        salt,
        auth: { nonce: prep.data.authNonce, signature },
        tuples,
      };
      const envelope = await signEnvelope("estate.enroll", payload, eoa);
      await enroll.mutateAsync(envelope);
      setDone(true);
      setTimeout(() => {
        setConfirming(false);
        onEnrolled();
      }, 1_600);
    } catch (err) {
      setError(
        err instanceof Error && err.message.includes("nothing was changed")
          ? "That didn't go through — nothing was set up. Try again."
          : "Something interrupted the setup — nothing was changed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (prep.isLoading) {
    return <p className="text-small text-muted-foreground">Preparing…</p>;
  }
  if (prep.isError || !prep.data) {
    return (
      <p className="text-small text-muted-foreground">
        Couldn&apos;t prepare the setup — nothing was changed. Refresh to try again.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-small text-muted-foreground">
        If you ever go quiet for a long time, everything in your account passes
        to someone you name — using only their email. Your everyday activity
        keeps the plan asleep.
      </p>

      {step === "who" && (
        <section className="flex flex-col gap-3" aria-label="Beneficiary">
          <label className="flex flex-col gap-1.5 text-small text-muted-foreground">
            Your beneficiary&apos;s email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="them@example.com"
              autoComplete="off"
              className="rounded-md border border-border bg-transparent px-3 py-2 text-body text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-small text-muted-foreground">
            Your name, as they&apos;ll see it (optional)
            <input
              type="text"
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              maxLength={80}
              placeholder="e.g. Amaka"
              className="rounded-md border border-border bg-transparent px-3 py-2 text-body text-foreground"
            />
          </label>
          <button
            type="button"
            disabled={!emailOk}
            onClick={() => setStep("when")}
            className="mt-1 min-h-11 rounded-lg bg-primary px-4 text-body font-medium text-primary-foreground transition-micro disabled:opacity-50"
          >
            Continue
          </button>
        </section>
      )}

      {step === "when" && (
        <section className="flex flex-col gap-3" aria-label="Quiet threshold">
          <label className="flex flex-col gap-1.5 text-small text-muted-foreground">
            How long you&apos;d be quiet before the plan wakes up
            <span className="flex items-center gap-2">
              <input
                type="number"
                min={30}
                max={3650}
                value={days}
                onChange={(e) => setDays(Number(e.target.value) || 0)}
                aria-label="Days of quiet"
                className="w-28 rounded-md border border-border bg-transparent px-3 py-2 text-body text-foreground tnum"
              />
              <span className="text-body text-foreground">days</span>
            </span>
          </label>
          <p className="text-caption text-muted-foreground">
            Between 30 days and 10 years. Any activity — a buy, a check-in, a
            single tap — resets the clock.
          </p>
          {demo && (
            <p className="text-caption text-warning-foreground/90 rounded-md bg-warning/20 px-3 py-2">
              Demo run: timers are minutes-scale here —{" "}
              <Num>{Math.round((prep.data.demoInactivitySecs ?? 120) / 60)}</Num>{" "}
              quiet minutes stand in for your {days} days. (demo: minutes)
            </p>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              disabled={!daysOk}
              onClick={() => setStep("review")}
              className="min-h-11 flex-1 rounded-lg bg-primary px-4 text-body font-medium text-primary-foreground transition-micro disabled:opacity-50"
            >
              Review
            </button>
            <button
              type="button"
              onClick={() => setStep("who")}
              className="min-h-11 px-3 text-small text-muted-foreground"
            >
              Back
            </button>
          </div>
        </section>
      )}

      {step === "review" && (
        <section className="flex flex-col gap-3" aria-label="Review">
          <PolicyCard
            kind="legacy"
            state="draft"
            title="Continuity"
            terms={legacyTerms({ beneficiaryEmail: email.trim(), inactivityDays: days })}
          />
          <p className="text-caption text-muted-foreground">{SOLANA_DISCLOSURE}</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="min-h-11 flex-1 rounded-lg bg-primary px-4 text-body font-medium text-primary-foreground transition-micro"
            >
              Set it up
            </button>
            <button
              type="button"
              onClick={() => setStep("when")}
              className="min-h-11 px-3 text-small text-muted-foreground"
            >
              Back
            </button>
          </div>
        </section>
      )}

      <ConfirmSheet
        open={confirming}
        onOpenChange={(open) => {
          if (!busy) setConfirming(open);
        }}
        sentence={`If you go quiet for ${days} days, everything passes to ${email.trim() || "your beneficiary"}.`}
        summary={
          demo
            ? "Demo run: minutes stand in for days here. One confirmation covers everything."
            : "One confirmation covers everything — no assets move today."
        }
        confirmLabel="Confirm"
        onConfirm={() => void confirmEnroll()}
        busy={busy}
        done={done}
        error={error}
      >
        {done ? (
          <p className="text-small text-foreground">
            Your plan is in place. Your everyday activity keeps it asleep.
          </p>
        ) : null}
      </ConfirmSheet>
    </div>
  );
}
