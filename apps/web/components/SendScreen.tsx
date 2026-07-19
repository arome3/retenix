"use client";

// /send (doc 15) — minimal Venmo-style: to / amount / confirm. Dollars only,
// USDC under the hood (PROPOSED: asset choice is withdraw's job), and NO
// network appears anywhere in this flow (G3 — withdraw is the single
// sanctioned exception, on its own screen). The recipient field auto-detects
// email / name / address; the live preview is send.resolve, and the server
// re-resolves at execute time regardless.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { SendToKind } from "@retenix/shared";
import {
  CHAIN_ID,
  SUPPORTED_TOKEN_TYPE,
  primaryTokenFor,
  type FeeTotalsUSD,
} from "@retenix/ua";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { CopyChip } from "@/components/CopyChip";
import { magic } from "@/lib/magic";
import { fmtUsd } from "@/lib/format";
import {
  quoteSendFees,
  resumePendingSendReport,
  runSend,
  type SendProgress,
  type SendRunResult,
} from "@/lib/send-runner";
import { trpc } from "@/lib/trpc";

/** email ↔ ENS-ish name ↔ address, from shape alone (the server re-checks). */
export function detectKind(value: string): SendToKind | null {
  const v = value.trim();
  if (!v) return null;
  if (v.includes("@")) return "email";
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return "address";
  if (!v.startsWith("0x") && /^[^\s.]+(\.[^\s.]+)+$/.test(v)) return "ens";
  return null;
}

const AMOUNT_RE = /^\d+(\.\d{0,2})?$/;

export function SendScreen({ eoa }: { eoa: string }) {
  const [to, setTo] = useState("");
  const [debouncedTo, setDebouncedTo] = useState("");
  const [amount, setAmount] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fees, setFees] = useState<FeeTotalsUSD | undefined>(undefined);
  const [progress, setProgress] = useState<SendProgress | null>(null);
  const [result, setResult] = useState<SendRunResult | null>(null);
  const [resumed, setResumed] = useState<SendRunResult | null>(null);

  // A stashed report from a closed tab delivers itself on return.
  const resumedOnce = useRef(false);
  useEffect(() => {
    if (resumedOnce.current) return;
    resumedOnce.current = true;
    void resumePendingSendReport(eoa).then((r) => {
      if (r) setResumed(r);
    });
  }, [eoa]);

  // Debounced live preview — the input itself is NEVER truncated (DS-9.3).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedTo(to), 350);
    return () => clearTimeout(t);
  }, [to]);
  const kind = detectKind(debouncedTo);
  const resolve = trpc.send.resolve.useQuery(
    { to: { kind: kind ?? "email", value: debouncedTo.trim() } },
    { enabled: kind !== null, staleTime: 30_000, retry: false },
  );

  const amountOk = AMOUNT_RE.test(amount) && Number(amount) >= 1 && Number(amount) <= 10_000;
  const amountUsd = amountOk ? Number(amount) : 0;
  const preview = kind !== null ? resolve.data : undefined;
  const sendable =
    amountOk &&
    kind !== null &&
    preview !== undefined &&
    (preview.status === "registered" ||
      preview.status === "unregistered" ||
      preview.status === "resolved");

  async function openConfirm(): Promise<void> {
    if (!sendable || kind === null) return;
    setResult(null);
    setProgress(null);
    setConfirming(true);
    setFees(undefined);
    // Advisory quote for the sheet (~ fees; a fresh quote signs later). Email
    // recipients' addresses stay server-side — the sender stands in.
    const usdc = primaryTokenFor(SUPPORTED_TOKEN_TYPE.USDC, CHAIN_ID.ARBITRUM_MAINNET_ONE);
    if (usdc) {
      try {
        setFees(
          await quoteSendFees(eoa, {
            token: { chainId: usdc.chainId, address: usdc.address },
            amountUnits: String(amountUsd),
            ...(preview?.status === "resolved" && preview.address
              ? { receiver: preview.address }
              : {}),
          }),
        );
      } catch {
        setFees(undefined); // the sheet simply shows no fee line
      }
    }
  }

  async function confirmSend(): Promise<void> {
    if (kind === null) return;
    setBusy(true);
    try {
      // The sender self-identifies for the recipient's receipt; the server
      // verifies the hash. Failure to read it just means the recipient sees
      // the sender's truncated address instead.
      let senderEmail: string | undefined;
      try {
        const info = (await magic.user.getInfo()) as { email?: string | null };
        senderEmail = info.email ?? undefined;
      } catch {
        senderEmail = undefined;
      }
      const res = await runSend(
        eoa,
        {
          to: { kind, value: debouncedTo.trim() },
          amountUsd,
          ...(senderEmail ? { senderEmail } : {}),
        },
        setProgress,
      );
      setResult(res);
    } finally {
      setBusy(false);
    }
  }

  const done = result?.kind === "sent" || result?.kind === "invited";
  const display = preview?.display ?? debouncedTo.trim();

  return (
    <div className="flex flex-col gap-4 pt-6">
      <h1 className="font-display text-title text-foreground">Send</h1>

      {resumed?.kind === "sent" && (
        <p className="rounded-lg border border-border bg-card p-3 text-small text-muted-foreground">
          Your last send finished — the receipt is in Activity.
        </p>
      )}

      <label className="flex flex-col gap-1.5 text-small text-muted-foreground">
        To
        <input
          type="text"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="email, name or address"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="rounded-md border border-border bg-transparent px-3 py-2 font-mono text-body text-foreground"
        />
      </label>

      {/* Live preview — statuses, never surprises at confirm time. */}
      {kind !== null && preview && (
        <div className="text-small" aria-live="polite">
          {preview.status === "registered" && (
            <p className="text-positive-fg">
              {preview.display} — they&apos;re on Retenix
            </p>
          )}
          {preview.status === "unregistered" && (
            <p className="text-muted-foreground">
              They don&apos;t have Retenix yet — we&apos;ll invite them instead of
              sending.
            </p>
          )}
          {preview.status === "resolved" && preview.address && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <span>Sends to</span>
              <CopyChip address={preview.address} />
            </div>
          )}
          {preview.status === "not-found" && (
            <p className="text-negative">name not found</p>
          )}
          {preview.status === "invalid" && (
            <p className="text-negative">that doesn&apos;t look right</p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="send-amount" className="text-small text-muted-foreground">
          Amount
        </label>
        <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
          <span aria-hidden="true" className="text-body text-muted-foreground">
            $
          </span>
          <input
            id="send-amount"
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="20.00"
            autoComplete="off"
            className="w-full bg-transparent text-body text-foreground tnum outline-none"
          />
        </div>
      </div>

      <button
        type="button"
        disabled={!sendable}
        onClick={() => void openConfirm()}
        className="mt-1 min-h-11 rounded-lg bg-primary px-4 text-body font-medium text-primary-foreground transition-micro disabled:opacity-50"
      >
        Review
      </button>

      <p className="text-caption text-muted-foreground">
        Sending somewhere specific?{" "}
        <Link href="/send/withdraw" className="text-foreground underline">
          Withdraw to an external account
        </Link>
      </p>

      <ConfirmSheet
        open={confirming}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(false);
            setResult(null);
          }
        }}
        sentence={`Send ${fmtUsd(amountUsd)} to ${display}`}
        fees={fees}
        confirmLabel="Confirm"
        onConfirm={() => void confirmSend()}
        busy={busy}
        done={done}
        error={result?.kind === "failed" ? result.message : null}
      >
        {progress && !result && (
          <p className="text-small text-muted-foreground" aria-live="polite">
            {progress.stage === "authorizing" && "Checking the details…"}
            {progress.stage === "signing" && "Confirming…"}
            {progress.stage === "settling" && "On its way…"}
            {progress.stage === "reporting" && "Almost done…"}
          </p>
        )}
        {result?.kind === "sent" && (
          <p className="text-small text-foreground" aria-live="polite">
            {result.receipt}
          </p>
        )}
        {result?.kind === "invited" && (
          <p className="text-small text-foreground" aria-live="polite">
            {result.message}
          </p>
        )}
        {result?.kind === "settling" && (
          <p className="text-small text-muted-foreground" aria-live="polite">
            Still settling — we&apos;ll finish the receipt when you come back.
          </p>
        )}
      </ConfirmSheet>
    </div>
  );
}
