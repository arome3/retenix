"use client";

// C13 · "How your money is protected" (doc 15, TS-14.4 as a FEATURE page,
// not fine print). Five blocks, spec-fixed order: the plain claim → the two
// named programs → live per-account status → one-tap revoke-all (typed word,
// the ONE sanctioned heavy confirmation) → the kill-switch explainer, key
// export and audit line. This page and receipts/breakdowns are the only
// places network names render (provenance context).
import Link from "next/link";
import { useState } from "react";
import {
  CLAIM_ADDRESSES,
  POLICY_CONTRACT_ADDRESS,
  REVOKE_ALL_TYPED_WORD,
  type DelegationRow,
} from "@retenix/shared";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { CopyChip } from "@/components/CopyChip";
import { personalSign, signEnvelope } from "@/lib/sign";
import { trpc } from "@/lib/trpc";
import { trpcVanilla } from "@/lib/trpc-vanilla"; // copy-canon-allow (scanner segment spans the doc-15 verbatim constant below)

// PS-4.3 required copy — verbatim (the sanctioned trust-proof phrase,
// CONFLICTS #15).
const PLAIN_CLAIM =
  "Your account is a standard address you can take anywhere. Limits are enforced by the chain, not by us.";

// Doc 15 §C13.2 on-page context line, calm register — verbatim.
const ONLY_TWO_PROGRAMS =
  "These are the only two programs your account ever delegates to."; // copy-canon-allow (doc-15 verbatim copy)

const EXPLORERS: Record<number, { name: string; base: string }> = {
  1: { name: "Etherscan", base: "https://etherscan.io/address/" },
  56: { name: "BscScan", base: "https://bscscan.com/address/" },
  8453: { name: "BaseScan", base: "https://basescan.org/address/" },
  196: { name: "OKLink", base: "https://www.oklink.com/xlayer/address/" },
  42161: { name: "Arbiscan", base: "https://arbiscan.io/address/" },
};

const ZERO_ADDR = `0x${"0".repeat(40)}`;

function programLabel(row: DelegationRow): string {
  if (!row.delegated || !row.delegate) return "—";
  if (row.delegate.kind === "ua") return "✓ Universal Account";
  if (row.delegate.kind === "claim") return "✓ RetenixClaim";
  const a = row.delegate.address ?? "";
  return `✓ ${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function SecurityScreen({ eoa }: { eoa: string }) {
  const liveStatus = trpc.security.delegations.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
  });
  const prepare = trpc.security.prepareRevokeAll.useQuery();

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revokeResult, setRevokeResult] = useState<
    | { kind: "done"; state: string; dismissed: number }
    | { kind: "error"; message: string }
    | null
  >(null);

  async function confirmRevokeAll(): Promise<void> {
    const prep = prepare.data;
    if (!prep?.needsRevoke || !prep.digest || !prep.nonce) return;
    setBusy(true);
    setRevokeResult(null);
    try {
      // Headless personal_sign over the doc-07 revokeAll digest (G5), then
      // the signed envelope — one confirmation, N signatures.
      const signature = await personalSign(prep.digest, eoa);
      const payload = { nonce: prep.nonce, signature };
      const envelope = await signEnvelope("security.revokeAll", payload, eoa);
      const res = await trpcVanilla.security.revokeAll.mutate(envelope);
      setRevokeResult({ kind: "done", state: res.state, dismissed: res.dismissed });
      void prepare.refetch();
    } catch (err) {
      setRevokeResult({
        kind: "error",
        message:
          err instanceof Error && err.message.includes("nothing was changed")
            ? "That didn't go through — nothing was changed. Try again."
            : "Something interrupted the dismissal. Check again in a moment.",
      });
    } finally {
      setBusy(false);
    }
  }

  const revocableCount = prepare.data?.revocable.length ?? 0;

  return (
    <div className="flex flex-col gap-6 pt-6 pb-8">
      <h1 className="font-display text-title text-foreground">
        How your money is protected
      </h1>

      {/* 1 · The plain claim (PS-4.3, verbatim) */}
      <p className="text-body text-foreground">{PLAIN_CLAIM}</p>

      {/* 2 · The two named programs */}
      <section aria-label="The two programs" className="flex flex-col gap-3">
        <h2 className="text-h2 text-foreground">Two programs, by name</h2>
        <p className="text-small text-muted-foreground">{ONLY_TWO_PROGRAMS}</p>

        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-body font-medium text-foreground">
            Universal Account
          </h3>
          <p className="mt-1 text-small text-muted-foreground">
            The engine that makes your balance work everywhere at once — built
            and audited by Particle.
          </p>
          <a
            href="https://developers.particle.network/universal-accounts/overview"
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-small text-foreground underline"
          >
            Read Particle&apos;s documentation
          </a>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-body font-medium text-foreground">RetenixClaim</h3>
          <p className="mt-1 text-small text-muted-foreground">
            The inheritance hand-over: one job (pass everything to the person
            you named), one destination, nothing else. It can act only after
            your inheritance plan&apos;s countdown completes.
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {Object.entries(CLAIM_ADDRESSES).map(([chainIdStr, address]) => {
              const chainId = Number(chainIdStr);
              const explorer = EXPLORERS[chainId];
              const deployed = address !== ZERO_ADDR;
              const label =
                { 1: "Ethereum", 56: "BSC", 8453: "Base", 196: "X Layer", 42161: "Arbitrum" }[
                  chainId
                ] ?? String(chainId); // copy-canon-allow (provenance context)
              return (
                <li
                  key={chainId}
                  className="flex flex-wrap items-center justify-between gap-2 text-small"
                >
                  <span className="text-muted-foreground">{label}</span>
                  {deployed && explorer ? (
                    <span className="flex items-center gap-2">
                      <CopyChip address={address} />
                      <a
                        href={`${explorer.base}${address}#code`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-foreground underline"
                      >
                        {explorer.name}
                      </a>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {"not yet active on this network" /* copy-canon-allow (provenance context) */}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      {/* 3 · Live status — the OQ5-typed panel; errors are honest, never a fake ✓ */}
      <section aria-label="Live status" className="flex flex-col gap-3">
        <h2 className="text-h2 text-foreground">Your account, right now</h2>
        {liveStatus.isLoading ? (
          <div className="flex flex-col gap-2" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : liveStatus.isError || !liveStatus.data || liveStatus.data.unavailable ? (
          <p className="text-small text-muted-foreground">
            couldn&apos;t check just now
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {liveStatus.data.rows.map((row) => (
              <li
                key={row.chainId}
                className="flex items-center justify-between rounded-lg border border-border px-4 py-2.5 text-small"
              >
                {/* copy-canon-allow — the delegation panel names networks (provenance) */}
                <span className="text-muted-foreground">{row.network}</span>
                <span
                  className={
                    row.delegated ? "font-mono text-foreground" : "text-muted-foreground"
                  }
                >
                  {programLabel(row)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 4 · One-tap revoke — the typed-word heavy confirmation (TS-14.5) */}
      <section aria-label="Dismiss all staff" className="flex flex-col gap-3">
        <h2 className="text-h2 text-foreground">Dismiss all staff</h2>
        <p className="text-small text-muted-foreground">
          One tap takes every agent&apos;s authority back — enforced on-chain.
          Nothing is sold; your money stays exactly where it is.
        </p>
        {revokeResult?.kind === "done" ? (
          <p className="text-small text-foreground" aria-live="polite">
            {revokeResult.dismissed === 0
              ? "Nothing to dismiss — no agent holds authority right now."
              : revokeResult.state === "confirmed"
                ? "Done. Every agent's authority is revoked."
                : "Dismissal sent — confirming now. Check back in a moment."}
          </p>
        ) : (
          <button
            type="button"
            disabled={prepare.isLoading || !prepare.data?.needsRevoke}
            onClick={() => setConfirming(true)}
            className="w-fit min-h-11 rounded-lg border border-destructive px-4 text-body font-medium text-destructive transition-micro disabled:opacity-50"
          >
            Dismiss all staff
          </button>
        )}
        {!prepare.isLoading && !prepare.data?.needsRevoke && !revokeResult && (
          <p className="text-caption text-muted-foreground">
            No agent holds authority right now.
          </p>
        )}
        <p className="text-caption text-muted-foreground">
          Need everything turned to cash too? That&apos;s the{" "}
          <Link href="/kill" className="text-foreground underline">
            kill switch
          </Link>
          .
        </p>
      </section>

      {/* 5 · Kill-switch explainer · key export · audit line */}
      <section aria-label="More protection" className="flex flex-col gap-3">
        <h2 className="text-h2 text-foreground">The full exit</h2>
        <p className="text-small text-muted-foreground">
          The kill switch is the stronger sibling: everything you hold becomes
          USDC in your balance and all agents lose authority — one press, no
          questions. Dismissing staff (above) removes authority without selling
          anything.
        </p>
        <Link
          href="/profile/export"
          className="w-fit rounded-lg border border-border px-4 py-2.5 text-body text-foreground transition-micro hover:bg-muted"
        >
          Export your key
        </Link>
        <p className="text-caption text-muted-foreground">
          Both programs are published and verified — the exact code is public:{" "}
          <a
            href={`${EXPLORERS[42161].base}${POLICY_CONTRACT_ADDRESS}#code`}
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline"
          >
            RetenixPolicy
          </a>{" "}
          ·{" "}
          <a
            href={`${EXPLORERS[42161].base}${CLAIM_ADDRESSES[42161]}#code`}
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline"
          >
            RetenixClaim
          </a>
        </p>
      </section>

      <ConfirmSheet
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        sentence={
          revocableCount === 1
            ? "Dismiss your staff — 1 agent loses authority"
            : `Dismiss all staff — ${revocableCount} agents lose authority`
        }
        summary="Nothing is sold. Your money stays where it is."
        confirmLabel="Confirm"
        onConfirm={() => void confirmRevokeAll()}
        busy={busy}
        done={revokeResult?.kind === "done"}
        error={revokeResult?.kind === "error" ? revokeResult.message : null}
        typedWord={REVOKE_ALL_TYPED_WORD}
      >
        {revokeResult?.kind === "done" && (
          <p className="text-small text-foreground" aria-live="polite">
            {revokeResult.state === "confirmed"
              ? "Done. Every agent's authority is revoked."
              : "Dismissal sent — confirming now."}
          </p>
        )}
      </ConfirmSheet>
    </div>
  );
}
