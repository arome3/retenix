"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { clearGate, getGateRegion, quizComplete } from "@/lib/gate";
import { trpc } from "@/lib/trpc";

const REGION = "/eligibility/region";
const READY = "/ready";

// PROPOSED (assembled from PS-required elements, Kraken register) — implement verbatim.
const ACK =
  "I understand tokenized stocks are not shares, may lose value, are not covered by investor-compensation schemes, and that Retenix provides no investment advice.";

export function RiskStep() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!getGateRegion() || !quizComplete()) {
      router.replace(REGION);
      return;
    }
    router.prefetch(READY);
  }, [router]);

  const ack = trpc.compliance.acknowledgeRisk.useMutation({
    onSuccess: () => {
      clearGate();
      router.replace(READY);
    },
    // Finalization refused (a prior step missing / out-of-order deep link) — the
    // region column stays "", so no access was granted. Restart the gate.
    onError: () => router.replace(REGION),
  });

  return (
    <section
      className="flex min-h-[80dvh] flex-col justify-center gap-8 py-12"
      aria-labelledby="risk-heading"
    >
      <header className="space-y-3">
        <h1 id="risk-heading" className="font-display text-display leading-tight">
          One thing to confirm
        </h1>
        <p className="text-body text-muted-foreground">
          Please read this before you continue.
        </p>
      </header>

      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4">
        <Checkbox
          className="mt-0.5 size-6"
          checked={checked}
          onCheckedChange={(value) => setChecked(value === true)}
        />
        <span className="text-body">{ACK}</span>
      </label>

      <Button
        className="w-full"
        disabled={!checked || ack.isPending}
        onClick={() => ack.mutate()}
      >
        Confirm
      </Button>
    </section>
  );
}
