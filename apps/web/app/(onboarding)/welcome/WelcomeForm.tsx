"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { beginOnboarding } from "@/lib/onboarding";
import { trpc } from "@/lib/trpc";

/*
 * The warm-path clock starts on the server, here (PS-F1-AC1).
 *
 * The write is awaited rather than fired-and-forgotten: a navigation can abort an
 * in-flight fetch, and losing this row loses the t=0 of the measurement. It is
 * capped, though — instrumentation may cost a moment, never someone's sign-in.
 */
const START_TIMEOUT_MS = 2_000;

export function WelcomeForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const track = trpc.auth.trackOnboarding.useMutation();

  // The warm path is email-delivery bound; everything after it should already be
  // on the wire by the time the user reads their code.
  useEffect(() => {
    router.prefetch("/otp");
    router.prefetch("/home");
  }, [router]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (!address || pending) return;

    setPending(true);
    const sid = beginOnboarding(address);
    await Promise.race([
      track.mutateAsync({ step: "started", sid }).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, START_TIMEOUT_MS)),
    ]);
    router.push("/otp");
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="email" className="block text-small text-muted-foreground">
          Email
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <Button type="submit" className="w-full" disabled={!email.trim() || pending}>
        Continue
      </Button>
      <p className="text-caption text-muted-foreground">
        We send you a code. There is no password to forget.
      </p>
    </form>
  );
}
