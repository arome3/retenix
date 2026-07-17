"use client";

// S6 · Heir claim (doc 14, design system §8 — a separate emotional register):
// paper-light even in dark mode (the /claim layout forces it), display-face
// lead "You've been named by [name]." → Magic onboarding (doc 02's EXACT
// flow — runLogin reused, the heir gets an account the moment the code
// verifies) → estate summary ("$4,812 · 14 assets · 5 sources") → ONE claim
// button → arrival + "Convert everything to USDC?" prompt. Zero crypto
// vocabulary end to end (PS-F7-AC3): account, confirm, sources. The heir
// never sees an address, and never a Solana anything (estate = the 5 covered
// networks).
import { useEffect, useRef, useState } from "react";
import {
  createUa,
  createConvertTransaction,
  getPrimaryAssets,
  parseFeeTotals,
  pollToTerminal,
  signAndSend,
  magicSigner,
  SUPPORTED_TOKEN_TYPE,
  type MagicSignerClient,
  type UniversalAccount,
} from "@retenix/ua";
import type { ClaimChainProgress, EstateSummary } from "@retenix/shared";
import {
  runLogin,
  type OtpHandle,
  type Session,
} from "@/app/(onboarding)/otp/OtpFlow";
import { OtpCodeInput } from "@/components/OtpCodeInput";
import { Num } from "@/components/Num";
import { clientEnv } from "@/env";
import { magic } from "@/lib/magic";
import { onSessionEstablished } from "@/lib/post-login";
import { trpc } from "@/lib/trpc";

// The summary hero matches the DS shape ("$4,812") — whole dollars, its own
// formatter (receipt amounts keep their exact-2dp rule; this is a display
// hero, module 08's two-formatters-two-jobs precedent).
const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

type Stage =
  | "lead"
  | "otp"
  | "summary"
  | "progress"
  | "arrival"
  | "converting"
  | "settled";

export function ClaimFlow({
  token,
  sessionEoa,
}: {
  token: string;
  /** Set when the visitor already holds a session (server-read). */
  sessionEoa: string | null;
}) {
  const info = trpc.estate.claimInfo.useQuery({ token }, { retry: false });
  const claimStart = trpc.estate.claimStart.useMutation();
  const [stage, setStage] = useState<Stage>("lead");
  const [eoa, setEoa] = useState<string | null>(sessionEoa);
  const [error, setError] = useState<string | null>(null);

  if (info.isLoading) {
    return <Lead loading />;
  }
  if (info.isError || !info.data) {
    return (
      <Shell>
        <p className="text-body text-foreground">
          This link isn&apos;t valid anymore.
        </p>
        <p className="text-small text-muted-foreground">
          If you were expecting something, ask the person who named you to send
          a fresh invitation.
        </p>
      </Shell>
    );
  }
  const { state, ownerName, summary } = info.data;
  if (state === "expired") {
    return (
      <Shell>
        <p className="text-body text-foreground">This link has expired.</p>
        <p className="text-small text-muted-foreground">
          Claim links work for 7 days. A new one can be sent — nothing was
          lost.
        </p>
      </Shell>
    );
  }

  async function startClaim(currentEoa: string) {
    setError(null);
    try {
      await claimStart.mutateAsync({ token });
      setStage("progress");
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("different email")) {
        setError(
          "This was left for a different email address. Confirm with the email that received the message.",
        );
        setEoa(null);
        setStage("otp");
      } else if (message.includes("already started")) {
        setStage("progress");
      } else {
        setError("That didn't go through — try again.");
      }
    }
    void currentEoa;
  }

  return (
    <div className="flex min-h-dvh flex-col justify-center gap-6 py-10">
      {stage === "lead" && (
        <Lead ownerName={ownerName} summary={summary}>
          <button
            type="button"
            onClick={() => setStage(eoa ? "summary" : "otp")}
            className="mt-2 min-h-12 w-full rounded-lg bg-primary px-4 text-body font-medium text-primary-foreground transition-micro"
          >
            See what was left for you
          </button>
        </Lead>
      )}

      {stage === "otp" && (
        <ClaimOtp
          error={error}
          onSession={(session) => {
            setEoa(session.eoa);
            setError(null);
            onSessionEstablished(session.eoa, session.region);
            setStage("summary");
          }}
        />
      )}

      {stage === "summary" && (
        <Shell>
          <SummaryCard summary={summary} />
          <button
            type="button"
            disabled={claimStart.isPending}
            onClick={() => eoa && void startClaim(eoa)}
            className="min-h-12 w-full rounded-lg bg-primary px-4 text-body font-medium text-primary-foreground transition-micro disabled:opacity-60"
          >
            {claimStart.isPending ? "Starting…" : "Claim what was left for you"}
          </button>
          {error ? <p className="text-small text-negative">{error}</p> : null}
          <p className="text-caption text-muted-foreground">
            One confirmation. Everything arrives in your own account — it was
            set aside for exactly this moment.
          </p>
        </Shell>
      )}

      {stage === "progress" && (
        <ClaimProgress token={token} onDone={() => setStage("arrival")} />
      )}

      {(stage === "arrival" || stage === "converting" || stage === "settled") && eoa && (
        <Arrival
          eoa={eoa}
          stage={stage}
          onConvert={() => setStage("converting")}
          onSettled={() => setStage("settled")}
          onKeep={() => setStage("settled")}
        />
      )}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-4 py-10">{children}</div>;
}

// ---------------------------------------------------------------------------
// Lead — the etching lives here (DS §5: thin-line, single-color ink; the
// module's illustration budget)
// ---------------------------------------------------------------------------
function Lead({
  ownerName,
  summary,
  loading,
  children,
}: {
  ownerName?: string | null;
  summary?: EstateSummary | null;
  loading?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <Etching />
      <h1 className="font-display text-display-lg text-foreground">
        {loading
          ? "One moment…"
          : ownerName
            ? `You’ve been named by ${ownerName}.`
            : "You’ve been named as a beneficiary."}
      </h1>
      {!loading && summary ? (
        <p className="text-body text-muted-foreground">
          Something was set aside for you — about{" "}
          <Num>{usdWhole.format(summary.totalUsd)}</Num>, waiting in one place.
        </p>
      ) : null}
      {children}
    </div>
  );
}

/** Thin-line etching (heritage register): an oak — what outlasts a season. */
function Etching() {
  return (
    <svg
      viewBox="0 0 120 120"
      width="112"
      height="112"
      aria-hidden="true"
      className="text-muted-foreground/50"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M60 104V56" />
      <path d="M60 72c-8-6-18-8-26-16" />
      <path d="M60 64c8-8 16-8 24-18" />
      <path d="M60 82c-6-4-14-2-20-8" />
      <path d="M22 46c0-18 17-30 38-30s38 12 38 30c0 12-9 22-21 25-4 1-9 2-17 2s-13-1-17-2c-12-3-21-13-21-25Z" />
      <path d="M38 34c4-6 12-10 22-10" />
      <path d="M20 104h80" />
      <path d="M32 110h56" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Estate summary ("$4,812 · 14 assets · 5 sources")
// ---------------------------------------------------------------------------
function SummaryCard({ summary }: { summary: EstateSummary | null }) {
  if (!summary) {
    return (
      <p className="text-body text-muted-foreground">
        Your inheritance is ready to claim.
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-card p-5 text-center">
      <p className="font-display text-display-lg text-foreground">
        <Num>{usdWhole.format(summary.totalUsd)}</Num>
      </p>
      <p className="mt-1 text-small text-muted-foreground">
        <Num>{summary.assetCount}</Num> assets ·{" "}
        <Num>{summary.sourceCount}</Num> sources
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OTP — doc 02's exact login sequence (runLogin), S6 chrome. The heir gets an
// account (EOA + one unified balance) the moment the code verifies.
// ---------------------------------------------------------------------------
function ClaimOtp({
  error,
  onSession,
}: {
  error: string | null;
  onSession: (session: Session) => void;
}) {
  const magicCallback = trpc.auth.magicCallback.useMutation();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"email" | "sending" | "code" | "checking" | "failed">(
    "email",
  );
  const [code, setCode] = useState("");
  const [invalid, setInvalid] = useState(false);
  const handleRef = useRef<OtpHandle | null>(null);
  const attemptRef = useRef(0);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  function start() {
    const attempt = ++attemptRef.current;
    setStatus("sending");
    setInvalid(false);
    void runLogin({
      email: email.trim(),
      magicUI: false,
      isCurrent: () => attemptRef.current === attempt,
      onHandle: (h) => {
        handleRef.current = h;
      },
      onSent: () => setStatus("code"),
      onInvalid: () => {
        setInvalid(true);
        setCode("");
        setStatus("code");
      },
      onTerminal: () => setStatus("failed"),
      onVerifying: () => setStatus("checking"),
      onSession,
      onFailure: () => setStatus("failed"),
      onRejectedBeforeSend: () => setStatus("failed"),
      exchange: async (didToken) => {
        const res = await magicCallback.mutateAsync({ didToken });
        return res as Session;
      },
    });
  }

  // auto-submit on the 6th digit — event-driven, never an effect
  // (react-hooks/set-state-in-effect; module 11's convention)
  function onCodeChange(digits: string) {
    setCode(digits);
    if (status === "code" && digits.length === 6) {
      setStatus("checking");
      handleRef.current?.emit("verify-email-otp", digits);
    }
  }

  return (
    <Shell>
      <h2 className="font-display text-title text-foreground">
        Confirm it&apos;s you
      </h2>
      <p className="text-small text-muted-foreground">
        Use the email that received the message — we&apos;ll send a one-time
        code, and your account is ready the moment you enter it.
      </p>
      {error ? <p className="text-small text-negative">{error}</p> : null}

      {status === "email" && (
        <>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            className="rounded-md border border-border bg-transparent px-3 py-2.5 text-body text-foreground"
          />
          <button
            type="button"
            disabled={!emailOk}
            onClick={start}
            className="min-h-12 rounded-lg bg-primary px-4 text-body font-medium text-primary-foreground transition-micro disabled:opacity-50"
          >
            Send my code
          </button>
        </>
      )}

      {status === "sending" && (
        <p role="status" className="text-small text-muted-foreground">
          Sending your code…
        </p>
      )}

      {(status === "code" || status === "checking") && (
        <>
          <OtpCodeInput
            value={code}
            onChange={onCodeChange}
            disabled={status === "checking"}
            invalid={invalid}
          />
          <p role="status" className="text-caption text-muted-foreground">
            {status === "checking"
              ? "Checking your code…"
              : invalid
                ? "That code didn't match. Check the newest email and try again."
                : `Enter the code sent to ${email.trim()}.`}
          </p>
        </>
      )}

      {status === "failed" && (
        <>
          <p className="text-small text-muted-foreground">
            That didn&apos;t go through. Send a fresh code to try again.
          </p>
          <button
            type="button"
            onClick={start}
            className="min-h-11 rounded-lg bg-primary px-4 text-body font-medium text-primary-foreground transition-micro"
          >
            Send another code
          </button>
        </>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Progress — S6 polls the keeper's per-chain work (continue-and-report:
// a held-up source is reported honestly while the others arrive)
// ---------------------------------------------------------------------------
const CHAIN_STATE_COPY: Record<ClaimChainProgress["state"], string> = {
  pending: "On its way",
  delegated: "On its way",
  registered: "On its way",
  claimed: "Arrived",
  "stale-tuple": "Needs a hand — our team will follow up",
  failed: "Needs a hand — our team will follow up",
  skipped: "Nothing to move",
};

function ClaimProgress({ token, onDone }: { token: string; onDone: () => void }) {
  const status = trpc.estate.claimStatus.useQuery(
    { token },
    { refetchInterval: 2_500 },
  );
  const done = status.data?.done ?? false;
  useEffect(() => {
    if (done) onDone();
  }, [done, onDone]);

  const sourceRows = status.data?.sources ?? [];
  return (
    <Shell>
      <h2 className="font-display text-title text-foreground">
        Bringing everything together…
      </h2>
      <ul aria-live="polite" className="flex flex-col gap-2">
        {sourceRows.length === 0 ? (
          <li className="text-small text-muted-foreground">Starting up…</li>
        ) : (
          sourceRows.map((c) => (
            <li
              key={c.chainId}
              className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-small"
            >
              {/* receipts/progress may name sources (doc 01 transparency) */}
              <span className="text-foreground">{c.network}</span>
              <span
                className={
                  c.state === "claimed" ? "text-positive" : "text-muted-foreground"
                }
              >
                {CHAIN_STATE_COPY[c.state]}
              </span>
            </li>
          ))
        )}
      </ul>
      <p className="text-caption text-muted-foreground">
        This runs on its own — you can keep this page open.
      </p>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Arrival + convert-all (standard UA convert, the heir's own session)
// ---------------------------------------------------------------------------
function Arrival({
  eoa,
  stage,
  onConvert,
  onSettled,
  onKeep,
}: {
  eoa: string;
  stage: "arrival" | "converting" | "settled";
  onConvert: () => void;
  onSettled: () => void;
  onKeep: () => void;
}) {
  const [totalUsd, setTotalUsd] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const assets = (await getPrimaryAssets(browserUa(eoa))) as {
          totalAmountInUSD?: number | string;
        };
        if (!cancelled && assets.totalAmountInUSD !== undefined) {
          setTotalUsd(Number(assets.totalAmountInUSD));
        }
      } catch {
        // the balance readout is a courtesy — the claim already landed
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eoa, stage]);

  async function convertAll() {
    onConvert();
    setNote(null);
    try {
      const ua = browserUa(eoa);
      const signer = magicSigner(magic as unknown as MagicSignerClient, eoa);
      const assets = (await getPrimaryAssets(ua)) as {
        assets?: {
          tokenType: string;
          amountInUSD: number;
          chainAggregation?: { amountInUSD: number; token?: { chainId?: number } }[];
        }[];
      };
      const toConvert = (assets.assets ?? []).filter(
        (a) => a.tokenType !== "usdc" && a.amountInUSD > 0.5,
      );
      for (const asset of toConvert) {
        // destination chain = where most of it already sits (fees stay small)
        const best = [...(asset.chainAggregation ?? [])].sort(
          (x, y) => y.amountInUSD - x.amountInUSD,
        )[0];
        const chainId = best?.token?.chainId;
        if (!chainId) continue;
        const tx = await createConvertTransaction(
          ua,
          {
            chainId,
            expectToken: {
              type: SUPPORTED_TOKEN_TYPE.USDC,
              amount: (asset.amountInUSD * 0.98).toFixed(2),
            },
          },
          { usePrimaryTokens: [asset.tokenType as SUPPORTED_TOKEN_TYPE] },
        );
        parseFeeTotals(tx); // quote sanity — fees surface in the tx itself
        const { transactionId } = await signAndSend(ua, tx, signer);
        await pollToTerminal(ua, transactionId, { intervalMs: 2_000, timeoutMs: 120_000 });
      }
      onSettled();
    } catch {
      setNote("Some of it couldn't convert right now — it's still yours, safe in your account.");
      onSettled();
    }
  }

  return (
    <Shell>
      <h2 className="font-display text-title text-foreground">
        {stage === "settled" ? "It’s yours." : "It’s arrived."}
      </h2>
      {totalUsd !== null ? (
        <p className="text-body text-muted-foreground">
          Your account now holds about <Num>{usdWhole.format(totalUsd)}</Num>.
        </p>
      ) : null}
      {stage === "arrival" && (
        <>
          <p className="text-small text-muted-foreground">
            Want it all in one steady place? We can convert everything to USDC —
            one confirmation, nothing leaves your account.
          </p>
          <button
            type="button"
            onClick={() => void convertAll()}
            className="min-h-12 rounded-lg bg-primary px-4 text-body font-medium text-primary-foreground transition-micro"
          >
            Convert everything to USDC
          </button>
          <button
            type="button"
            onClick={onKeep}
            className="min-h-11 text-small text-muted-foreground"
          >
            Keep it as it is
          </button>
        </>
      )}
      {stage === "converting" && (
        <p role="status" className="text-small text-muted-foreground">
          Converting — this settles on its own…
        </p>
      )}
      {stage === "settled" && note ? (
        <p className="text-small text-muted-foreground">{note}</p>
      ) : null}
    </Shell>
  );
}

function browserUa(eoa: string): UniversalAccount {
  return createUa({
    ownerAddress: eoa,
    credentials: {
      projectId: clientEnv.NEXT_PUBLIC_PARTICLE_PROJECT_ID,
      projectClientKey: clientEnv.NEXT_PUBLIC_PARTICLE_CLIENT_KEY,
      projectAppUuid: clientEnv.NEXT_PUBLIC_PARTICLE_APP_UUID,
    },
  });
}
