"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getGateRegion, quizComplete } from "@/lib/gate";
import { trpc } from "@/lib/trpc";

const REGION = "/eligibility/region";
const RISK = "/eligibility/risk";

export function IdentityStep() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");

  // Order guard (server is authoritative at finalization); prefetch next.
  useEffect(() => {
    if (!getGateRegion() || !quizComplete()) {
      router.replace(REGION);
      return;
    }
    router.prefetch(RISK);
  }, [router]);

  const submit = trpc.compliance.submitIdentity.useMutation({
    onSuccess: () => router.push(RISK),
    onError: () => router.replace(REGION),
  });

  const ready = name.trim().length > 0 && dob.trim().length > 0;

  return (
    <section
      className="flex min-h-[80dvh] flex-col justify-center gap-8 py-12"
      aria-labelledby="identity-heading"
    >
      <header className="space-y-3">
        <h1
          id="identity-heading"
          className="font-display text-display leading-tight"
        >
          Your details
        </h1>
        <p className="text-body text-muted-foreground">
          A name and date of birth for your account records.
        </p>
      </header>

      {/* Persistent, plain, and honest (PS-10.4) — must survive design polish. */}
      <p
        role="note"
        className="rounded-md border border-border bg-muted px-3 py-2 text-caption text-muted-foreground"
      >
        Demo: identity verification is simulated for this hackathon build.
      </p>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !submit.isPending) {
            submit.mutate({ name: name.trim(), dob });
          }
        }}
      >
        <div className="space-y-2">
          <label
            htmlFor="identity-name"
            className="text-caption text-muted-foreground"
          >
            Full name
          </label>
          <Input
            id="identity-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            required
          />
        </div>
        <div className="space-y-2">
          <label
            htmlFor="identity-dob"
            className="text-caption text-muted-foreground"
          >
            Date of birth
          </label>
          <Input
            id="identity-dob"
            type="date"
            className="tnum"
            value={dob}
            onChange={(event) => setDob(event.target.value)}
            required
          />
        </div>
        <Button
          type="submit"
          className="w-full"
          disabled={!ready || submit.isPending}
        >
          Continue
        </Button>
      </form>
    </section>
  );
}
