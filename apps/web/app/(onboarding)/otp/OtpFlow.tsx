"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { OTP_LENGTH, OtpCodeInput } from "@/components/OtpCodeInput";
import { Button } from "@/components/ui/button";
import { magic } from "@/lib/magic";
import { forgetOnboardingEmail, readOnboarding } from "@/lib/onboarding";
import { onSessionEstablished } from "@/lib/post-login";
import { trpc } from "@/lib/trpc";

/*
 * Branded OTP entry (doc 02, 2026-07-10 revision): `showUI: false` drives
 * Magic through its custom-UI events and the code is collected here, in
 * Retenix chrome. If a custom attempt dies before the email goes out (a Magic
 * plan without white-labeling — OQ4 unresolved), the flow falls back to
 * Magic's hosted window once, so login never breaks.
 */

type Status =
  | "sending" // Magic is emailing the code
  | "code" // branded entry is up; `notice` may carry an inline error
  | "checking" // code handed to Magic, verdict pending
  | "verifying" // DID token → server session exchange
  | "waiting" // fallback only: Magic's own window is showing
  | "expired"
  | "locked"
  | "throttled"
  | "cancelled"
  | "unavailable";

type Notice = "invalid" | null;
export type Session = { eoa: string; region: string };
export type OtpHandle = {
  emit(event: "cancel"): unknown;
  emit(event: "verify-email-otp", otp: string): unknown;
};

const RESEND_AFTER_MS = 30_000;

const COPY: Record<Status, string> = {
  sending: "Sending your code…",
  code: "", // the input is the message; the live region stays mounted
  checking: "Checking your code…",
  verifying: "Confirming your code…",
  waiting: "Enter the code in the secure window.",
  expired: "That code expired. Send another and use the newest one.",
  locked: "Too many wrong codes. Send a fresh one to start over.",
  throttled: "Too many tries for now. Wait a minute, then send another code.",
  cancelled: "You closed the code entry. Send another when you are ready.",
  unavailable:
    "Sign-in is unavailable right now. Nothing was created — try again in a moment.",
};

const INVALID_COPY =
  "That code didn't match. Check the newest email and try again.";

// sessionStorage read as an external store: it has no server value, and reading
// it into state from an effect would cascade a render on every mount.
const noSubscribe = () => () => {};
const readEmail = () => readOnboarding().email;
const noEmailOnServer = () => null;

export type LoginHooks = {
  email: string;
  /** True on the fallback path: Magic's hosted window collects the code. */
  magicUI: boolean;
  /** False once a newer attempt has superseded this one. */
  isCurrent: () => boolean;
  onHandle: (handle: OtpHandle) => void;
  onSent: () => void;
  onInvalid: () => void;
  onTerminal: (status: "expired" | "locked" | "throttled") => void;
  onVerifying: () => void;
  onSession: (session: Session) => void;
  onFailure: (status: "cancelled" | "unavailable") => void;
  /** Custom-UI attempt died before the email went out — likely a plan without
   *  white-labeling. The caller decides whether to retry with Magic's window. */
  onRejectedBeforeSend: () => void;
  exchange: (didToken: string) => Promise<Session>;
};

/*
 * Doc 02's login sequence, custom-UI variant. Module scope on purpose: this
 * drives an external system (Magic, then our server), and the component only
 * listens. Exported for doc 14's S6 heir onboarding — "doc 02's exact flow",
 * reused rather than re-derived.
 */
export async function runLogin(hooks: LoginHooks): Promise<void> {
  let closedByUser = false;
  let sent = false;
  let terminal = false;
  try {
    const handle = magic.auth.loginWithEmailOTP({
      email: hooks.email,
      showUI: hooks.magicUI,
      // deviceCheckUI stays default (true): new-device approval is a security
      // interstitial Magic owns; the branded flow covers the everyday path.
    });
    hooks.onHandle(handle);
    handle.on("email-otp-sent", () => {
      sent = true;
      if (hooks.isCurrent()) hooks.onSent();
    });
    if (!hooks.magicUI) {
      handle.on("invalid-email-otp", () => {
        // Not terminal — Magic allows retries until max-attempts-reached.
        if (hooks.isCurrent()) hooks.onInvalid();
      });
      handle.on("expired-email-otp", () => {
        terminal = true;
        if (hooks.isCurrent()) hooks.onTerminal("expired");
      });
      handle.on("max-attempts-reached", () => {
        terminal = true;
        if (hooks.isCurrent()) hooks.onTerminal("locked");
      });
      handle.on("login-throttled", () => {
        terminal = true;
        if (hooks.isCurrent()) hooks.onTerminal("throttled");
      });
    }
    handle.on("closed-by-user", () => {
      closedByUser = true;
    });
    await handle; // resolves once Magic verifies the code

    if (!hooks.isCurrent()) return;
    hooks.onVerifying();

    const didToken = await magic.user.getIdToken(); // short-lived DID token
    const session = await hooks.exchange(didToken); // -> server session

    // Doc 02's fourth call. The address Retenix trusts is the one the server read
    // out of the DID token, so this is not where it comes from — it hydrates
    // Magic's user module for the signing that follows.
    await magic.user.getInfo();

    if (!hooks.isCurrent()) return;
    hooks.onSession(session);
  } catch {
    if (!hooks.isCurrent()) return;
    // Terminal events already told the user what happened; the rejection that
    // follows them carries no new information.
    if (terminal) return;
    if (!hooks.magicUI && !sent && !closedByUser) {
      hooks.onRejectedBeforeSend();
      return;
    }
    // A failed login leaves no session at all — never a partial one.
    hooks.onFailure(closedByUser ? "cancelled" : "unavailable");
  }
}

export function OtpFlow() {
  const router = useRouter();
  const magicCallback = trpc.auth.magicCallback.useMutation();

  const email = useSyncExternalStore(noSubscribe, readEmail, noEmailOnServer);
  const [status, setStatus] = useState<Status>("sending");
  const [notice, setNotice] = useState<Notice>(null);
  const [codeValue, setCodeValue] = useState("");
  const [canResend, setCanResend] = useState(false);

  // Each attempt owns a number, so a late rejection from a cancelled attempt
  // cannot overwrite the status of the one that replaced it.
  const attemptRef = useRef(0);
  const handleRef = useRef<OtpHandle | null>(null);

  const start = useCallback(
    function startAttempt(address: string, magicUI = false) {
      const attempt = (attemptRef.current += 1);
      void runLogin({
        email: address,
        magicUI,
        isCurrent: () => attemptRef.current === attempt,
        onHandle: (handle) => {
          handleRef.current = handle;
        },
        onSent: () => {
          if (magicUI) {
            setStatus("waiting");
            return;
          }
          setNotice(null);
          setCodeValue("");
          setStatus("code");
        },
        onInvalid: () => {
          setCodeValue("");
          setNotice("invalid");
          setStatus("code");
        },
        onTerminal: (next) => {
          setStatus(next);
          setCanResend(true);
        },
        onVerifying: () => setStatus("verifying"),
        onFailure: (next) => {
          setStatus(next);
          setCanResend(true);
        },
        // Only reachable from the custom attempt (runLogin guards on !magicUI),
        // so the retry below cannot loop.
        onRejectedBeforeSend: () => startAttempt(address, true),
        exchange: (didToken) => magicCallback.mutateAsync({ didToken }),
        onSession: (session) => {
          forgetOnboardingEmail();
          // Doc 03's UA init and doc 05's warm-up start now, awaited by nobody.
          onSessionEstablished(session.eoa, session.region);
          router.replace(session.region ? "/ready" : "/eligibility");
        },
      });
    },
    [magicCallback, router],
  );

  // Runs once per mount; a StrictMode double-invoke must not send two codes.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // Read directly rather than off the hydration-time snapshot, which is null.
    const stored = readOnboarding().email;
    if (!stored) {
      router.replace("/welcome"); // Arrived without going through /welcome.
      return;
    }
    start(stored);
  }, [router, start]);

  // The email may simply be slow. Offer another after a fair wait, not before.
  useEffect(() => {
    if (status !== "sending" && status !== "waiting" && status !== "code") return;
    const timer = setTimeout(() => setCanResend(true), RESEND_AFTER_MS);
    return () => clearTimeout(timer);
  }, [status]);

  function resend() {
    if (!email) return;
    const handle = handleRef.current;
    handleRef.current = null;
    try {
      handle?.emit("cancel");
    } catch {
      // Already settled; the new attempt supersedes it regardless.
    }
    setStatus("sending");
    setNotice(null);
    setCodeValue("");
    setCanResend(false);
    start(email); // fresh attempts retry the branded path first
  }

  function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status !== "code" || codeValue.length !== OTP_LENGTH) return;
    const handle = handleRef.current;
    if (!handle) return;
    setNotice(null);
    setStatus("checking");
    try {
      handle.emit("verify-email-otp", codeValue);
    } catch {
      setStatus("unavailable");
      setCanResend(true);
    }
  }

  const busy =
    status === "sending" || status === "checking" || status === "verifying";
  const statusLine = notice === "invalid" ? INVALID_COPY : COPY[status];
  const emphasized =
    notice === "invalid" ||
    status === "expired" ||
    status === "locked" ||
    status === "throttled" ||
    status === "unavailable";

  return (
    <>
      <header className="space-y-3">
        <h1 className="font-display text-display leading-tight">
          Check your email
        </h1>
        <p className="text-body text-muted-foreground">
          {email ? (
            <>
              We sent a code to <span className="text-foreground">{email}</span>.
            </>
          ) : (
            "We sent you a code."
          )}
        </p>
      </header>

      <div className="space-y-4">
        {(status === "code" || status === "checking") && (
          <form onSubmit={submitCode} className="space-y-4">
            <OtpCodeInput
              value={codeValue}
              onChange={setCodeValue}
              disabled={status !== "code"}
              invalid={notice === "invalid"}
            />
            <Button
              type="submit"
              className="w-full"
              disabled={status !== "code" || codeValue.length !== OTP_LENGTH}
            >
              Verify code
            </Button>
          </form>
        )}

        <p
          aria-live="polite"
          className={
            emphasized
              ? "text-body text-foreground"
              : "text-body text-muted-foreground"
          }
        >
          {statusLine}
        </p>

        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={resend}
          disabled={!canResend || busy}
        >
          Send another code
        </Button>

        <Link
          href="/welcome"
          className="block text-center text-small text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Use a different email
        </Link>
      </div>
    </>
  );
}
