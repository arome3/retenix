"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { magic } from "@/lib/magic";
import { forgetOnboardingEmail, readOnboarding } from "@/lib/onboarding";
import { onSessionEstablished } from "@/lib/post-login";
import { trpc } from "@/lib/trpc";

type Status = "sending" | "waiting" | "verifying" | "cancelled" | "unavailable";
type Session = { eoa: string; region: string };
type Cancellable = { emit: (event: "cancel") => unknown };

const RESEND_AFTER_MS = 30_000;

const COPY: Record<Status, string> = {
  sending: "Sending your code…",
  waiting: "Waiting for your code…",
  verifying: "Confirming your code…",
  cancelled: "You closed the code entry. Send another when you are ready.",
  unavailable:
    "Sign-in is unavailable right now. Nothing was created — try again in a moment.",
};

// sessionStorage read as an external store: it has no server value, and reading
// it into state from an effect would cascade a render on every mount.
const noSubscribe = () => () => {};
const readEmail = () => readOnboarding().email;
const noEmailOnServer = () => null;

type LoginHooks = {
  email: string;
  /** False once a newer attempt has superseded this one. */
  isCurrent: () => boolean;
  onHandle: (handle: Cancellable) => void;
  onSent: () => void;
  onVerifying: () => void;
  onSession: (session: Session) => void;
  onFailure: (status: "cancelled" | "unavailable") => void;
  exchange: (didToken: string) => Promise<Session>;
};

/*
 * Doc 02's login sequence, verbatim. Module scope on purpose: this drives an
 * external system (Magic, then our server), and the component only listens.
 */
async function runLogin(hooks: LoginHooks): Promise<void> {
  let closedByUser = false;
  try {
    const handle = magic.auth.loginWithEmailOTP({ email: hooks.email });
    hooks.onHandle(handle);
    handle.on("email-otp-sent", () => {
      if (hooks.isCurrent()) hooks.onSent();
    });
    handle.on("closed-by-user", () => {
      closedByUser = true;
    });
    await handle; // Magic renders the OTP UI over this screen

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
    // A failed login leaves no session at all — never a partial one.
    hooks.onFailure(closedByUser ? "cancelled" : "unavailable");
  }
}

export function OtpFlow() {
  const router = useRouter();
  const magicCallback = trpc.auth.magicCallback.useMutation();

  const email = useSyncExternalStore(noSubscribe, readEmail, noEmailOnServer);
  const [status, setStatus] = useState<Status>("sending");
  const [canResend, setCanResend] = useState(false);

  // Each attempt owns a number, so a late rejection from a cancelled attempt
  // cannot overwrite the status of the one that replaced it.
  const attemptRef = useRef(0);
  const handleRef = useRef<Cancellable | null>(null);

  const start = useCallback(
    (address: string) => {
      const attempt = (attemptRef.current += 1);
      void runLogin({
        email: address,
        isCurrent: () => attemptRef.current === attempt,
        onHandle: (handle) => {
          handleRef.current = handle;
        },
        onSent: () => setStatus("waiting"),
        onVerifying: () => setStatus("verifying"),
        onFailure: (next) => {
          setStatus(next);
          setCanResend(true);
        },
        exchange: (didToken) => magicCallback.mutateAsync({ didToken }),
        onSession: (session) => {
          forgetOnboardingEmail();
          // Doc 03's UA init and doc 05's warm-up start now, awaited by nobody.
          onSessionEstablished(session.eoa);
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
    if (status !== "sending" && status !== "waiting") return;
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
    setCanResend(false);
    start(email);
  }

  const busy = status === "sending" || status === "verifying";

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
        <p
          aria-live="polite"
          className={
            status === "unavailable"
              ? "text-body text-foreground"
              : "text-body text-muted-foreground"
          }
        >
          {COPY[status]}
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
