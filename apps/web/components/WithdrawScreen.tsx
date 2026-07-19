"use client";

// /send/withdraw (doc 15) — THE single sanctioned network-choice surface
// (CONFLICTS #16). The destination network is framed as a property of the
// EXTERNAL destination ("Where should it arrive?"), never of the user's own
// balance, and it is NEVER default-selected. Everything else in the app
// stays network-free.
import { useState } from "react";
import {
  CHAIN_ID,
  RETENIX_PRIMARY_ASSETS,
  networksForAsset,
  primaryTokenFor,
  type FeeTotalsUSD,
  type SUPPORTED_TOKEN_TYPE,
} from "@retenix/ua";
import { networkName } from "@retenix/shared";

import { useNamedSource } from "@/hooks/use-named-source";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { fmtUsd } from "@/lib/format";
import {
  quoteSendFees,
  runSend,
  type SendProgress,
  type SendRunResult,
} from "@/lib/send-runner";

const ASSET_LABELS: Record<string, string> = {
  usdc: "USDC",
  usdt: "USDT",
  eth: "ETH",
  bnb: "BNB",
  sol: "SOL",
};

const AMOUNT_RE = /^\d+(\.\d{0,2})?$/;
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // copy-canon-allow (regex, not user copy)

type Step = "asset" | "address" | "destination";

export function WithdrawScreen({ eoa }: { eoa: string }) {
  const [step, setStep] = useState<Step>("asset");
  const [asset, setAsset] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [address, setAddress] = useState("");
  const [chainId, setChainId] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fees, setFees] = useState<FeeTotalsUSD | undefined>(undefined);
  const [progress, setProgress] = useState<SendProgress | null>(null);
  const [result, setResult] = useState<SendRunResult | null>(null);

  const amountOk =
    AMOUNT_RE.test(amount) && Number(amount) >= 1 && Number(amount) <= 10_000;
  const amountUsd = amountOk ? Number(amount) : 0;
  const addressShapeOk = EVM_ADDR_RE.test(address.trim()) || BASE58_RE.test(address.trim());

  const networks = asset
    ? networksForAsset(asset as unknown as SUPPORTED_TOKEN_TYPE)
    : [];

  // PS-8.2: the destination step is doc 15's one sanctioned network-choice
  // surface — it names them in the selector and again on the arrival line.
  // Mirrors the render gate below exactly.
  useNamedSource("withdraw", step === "destination" && asset !== null);

  // The chosen network decides which address family is valid — a mismatch is
  // caught here, before the confirm (the server re-validates regardless).
  const familyMismatch =
    chainId !== null &&
    (chainId === CHAIN_ID.SOLANA_MAINNET
      ? !BASE58_RE.test(address.trim())
      : !EVM_ADDR_RE.test(address.trim()));

  async function openConfirm(): Promise<void> {
    if (!asset || chainId === null || familyMismatch) return;
    setResult(null);
    setProgress(null);
    setConfirming(true);
    setFees(undefined);
    // Advisory ~fees for stables (1:1 units); non-stables are priced
    // server-side at authorize, so their preview shows no fee line.
    if (asset === "usdc" || asset === "usdt") {
      const token = primaryTokenFor(asset as unknown as SUPPORTED_TOKEN_TYPE, chainId);
      if (token) {
        try {
          setFees(
            await quoteSendFees(eoa, {
              token: { chainId, address: token.address },
              amountUnits: String(amountUsd),
              receiver: address.trim(),
            }),
          );
        } catch {
          setFees(undefined);
        }
      }
    }
  }

  async function confirmWithdraw(): Promise<void> {
    if (!asset || chainId === null) return;
    setBusy(true);
    try {
      const res = await runSend(
        eoa,
        {
          to: { kind: "address", value: address.trim() },
          amountUsd,
          asset,
          chainId,
        },
        setProgress,
      );
      setResult(res);
    } finally {
      setBusy(false);
    }
  }

  const done = result?.kind === "sent";
  const stepButton =
    "mt-1 min-h-11 rounded-lg bg-primary px-4 text-body font-medium text-primary-foreground transition-micro disabled:opacity-50";

  return (
    <div className="flex flex-col gap-4 pt-6">
      <h1 className="font-display text-title text-foreground">Withdraw</h1>

      {step === "asset" && (
        <section className="flex flex-col gap-3" aria-label="What to withdraw">
          <fieldset className="flex flex-col gap-2">
            <legend className="text-small text-muted-foreground">
              What should leave your account?
            </legend>
            <div className="flex flex-wrap gap-2">
              {(RETENIX_PRIMARY_ASSETS as readonly string[]).map((a) => (
                <label
                  key={a}
                  className={`min-h-11 cursor-pointer rounded-lg border px-4 py-2.5 text-body transition-micro ${
                    asset === a
                      ? "border-primary text-foreground"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  <input
                    type="radio"
                    name="withdraw-asset"
                    value={a}
                    checked={asset === a}
                    onChange={() => {
                      setAsset(a);
                      setChainId(null); // a new asset resets the (never-defaulted) choice
                    }}
                    className="sr-only"
                  />
                  {ASSET_LABELS[a] ?? a.toUpperCase()}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="withdraw-amount" className="text-small text-muted-foreground">
              Amount
            </label>
            <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
              <span aria-hidden="true" className="text-body text-muted-foreground">
                $
              </span>
              <input
                id="withdraw-amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="2.00"
                autoComplete="off"
                className="w-full bg-transparent text-body text-foreground tnum outline-none"
              />
            </div>
          </div>
          <button
            type="button"
            disabled={!asset || !amountOk}
            onClick={() => setStep("address")}
            className={stepButton}
          >
            Continue
          </button>
        </section>
      )}

      {step === "address" && (
        <section className="flex flex-col gap-3" aria-label="Destination">
          <label className="flex flex-col gap-1.5 text-small text-muted-foreground">
            Destination address
            {/* never truncated inside an input (DS-9.3) */}
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="the receiving account's address"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="rounded-md border border-border bg-transparent px-3 py-2 font-mono text-body text-foreground"
            />
          </label>
          {address.trim() !== "" && !addressShapeOk && (
            <p className="text-small text-negative">
              that address doesn&apos;t look right
            </p>
          )}
          <button
            type="button"
            disabled={!addressShapeOk}
            onClick={() => setStep("destination")}
            className={stepButton}
          >
            Continue
          </button>
        </section>
      )}

      {step === "destination" && asset && (
        <section className="flex flex-col gap-3" aria-label="Where should it arrive?">
          <fieldset className="flex flex-col gap-2">
            <legend className="text-body text-foreground">
              Where should it arrive?
            </legend>
            <p className="text-small text-muted-foreground">
              Ask the receiving account if you&apos;re unsure.
            </p>
            <div className="flex flex-col gap-2" role="none">
              {networks.map((id) => (
                <label
                  key={id}
                  className={`flex min-h-11 cursor-pointer items-center rounded-lg border px-4 text-body transition-micro ${
                    chainId === id
                      ? "border-primary text-foreground"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  <input
                    type="radio"
                    name="withdraw-destination"
                    value={id}
                    checked={chainId === id}
                    onChange={() => setChainId(id)}
                    className="sr-only"
                  />
                  {/* copy-canon-allow — CONFLICTS #16: THE sanctioned network-choice surface */}
                  {networkName(id)}
                </label>
              ))}
            </div>
          </fieldset>
          {familyMismatch && (
            <p className="text-small text-negative">
              that address doesn&apos;t match this destination
            </p>
          )}
          <button
            type="button"
            disabled={chainId === null || familyMismatch}
            onClick={() => void openConfirm()}
            className={stepButton}
          >
            Review
          </button>
        </section>
      )}

      <ConfirmSheet
        open={confirming}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(false);
            setResult(null);
          }
        }}
        sentence={`Withdraw ${fmtUsd(amountUsd)} of ${asset ? (ASSET_LABELS[asset] ?? asset) : ""}`}
        fees={fees}
        confirmLabel="Confirm"
        onConfirm={() => void confirmWithdraw()}
        busy={busy}
        done={done}
        error={result?.kind === "failed" ? result.message : null}
      >
        {chainId !== null && !result && (
          <p className="text-small text-foreground">
            {/* copy-canon-allow — CONFLICTS #16: the explicit arrival line */}
            Arrives on {networkName(chainId)} — make sure the address expects it
            there.
          </p>
        )}
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
        {result?.kind === "settling" && (
          <p className="text-small text-muted-foreground" aria-live="polite">
            Still settling — we&apos;ll finish the receipt when you come back.
          </p>
        )}
      </ConfirmSheet>
    </div>
  );
}
