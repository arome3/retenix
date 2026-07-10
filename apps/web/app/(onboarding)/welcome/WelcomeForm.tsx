"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { beginOnboarding } from "@/lib/onboarding";
import { trpc } from "@/lib/trpc";

export function WelcomeForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const track = trpc.auth.trackOnboarding.useMutation();

  // The warm path is email-delivery bound; everything after it should already
  // be on the wire by the time the user reads their code.
  useEffect(() => {
    router.prefetch("/otp");
    router.prefetch("/home");
  }, [router]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;

    const sid = beginOnboarding(address);
    // Starts the clock on the server, and never blocks the navigation.
    track.mutate({ step: "started", sid });
    router.push("/otp");
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate={false}>
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
      <Button type="submit" className="w-full" disabled={!email.trim()}>
        Continue
      </Button>
      <p className="text-caption text-muted-foreground">
        We send you a code. There is no password to forget.
      </p>
    </form>
  );
}
