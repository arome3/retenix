"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CountryCombobox } from "@/components/CountryCombobox";
import { Button } from "@/components/ui/button";
import { setGateRegion } from "@/lib/gate";
import { trpc } from "@/lib/trpc";

const NEXT = "/eligibility/quiz/1";

export function RegionStep() {
  const router = useRouter();
  const [code, setCode] = useState<string | null>(null);
  // Shown after a restricted pick — a working alternative, never a wall.
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    router.prefetch(NEXT);
  }, [router]);

  const setRegion = trpc.compliance.setRegion.useMutation({
    onSuccess: ({ region, equityEligible }) => {
      setGateRegion(region);
      if (equityEligible) {
        router.push(NEXT);
      } else {
        setBlocked(true);
      }
    },
    onError: () => {
      // Region is set exactly once. Re-picking a different region is refused
      // (anti gate-shopping) — the pick already on record stands, so move on.
      router.push(NEXT);
    },
  });

  if (blocked) {
    return (
      <section
        className="flex min-h-[80dvh] flex-col justify-center gap-8 py-12"
        aria-labelledby="blocked-heading"
      >
        <header className="space-y-3">
          <h1
            id="blocked-heading"
            className="font-display text-display leading-tight"
          >
            Tokenized stocks aren&apos;t available in your region
          </h1>
          <p className="text-body text-muted-foreground">
            You can still invest in a crypto basket — SOL and ETH — plus
            tokenized gold, with the same automation and the same controls.
          </p>
        </header>
        <Button className="w-full" onClick={() => router.push(NEXT)}>
          Continue
        </Button>
      </section>
    );
  }

  return (
    <section
      className="flex min-h-[80dvh] flex-col justify-center gap-8 py-12"
      aria-labelledby="region-heading"
    >
      <header className="space-y-3">
        <h1
          id="region-heading"
          className="font-display text-display leading-tight"
        >
          Where are you investing from?
        </h1>
        <p className="text-body text-muted-foreground">
          We ask so we only offer you what you can actually hold. You set this
          once.
        </p>
      </header>

      <div className="space-y-2">
        <p className="text-caption text-muted-foreground">Region</p>
        <CountryCombobox
          value={code}
          onChange={setCode}
          disabled={setRegion.isPending}
        />
      </div>

      <Button
        className="w-full"
        disabled={!code || setRegion.isPending}
        onClick={() => code && setRegion.mutate({ region: code })}
      >
        Continue
      </Button>
    </section>
  );
}
