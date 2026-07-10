"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

/*
 * C12 EligibilityGate lives here — doc 04 owns its content: the country select,
 * the restricted-region block, the three-question appropriateness quiz, the risk
 * acknowledgment, and the region model behind users.region.
 *
 * S1 only hosts the slot, because the gate must stand before any asset screen.
 * Until doc 04 lands, the placeholder below keeps S1 walkable in development —
 * `devAffordances` is false in every production build, so the button cannot
 * reach a user. Doc 04 deletes this component and auth.devSetRegion with it.
 */
export function EligibilityGateSlot({ devPassthrough }: { devPassthrough: boolean }) {
  const router = useRouter();
  const setRegion = trpc.auth.devSetRegion.useMutation({
    onSuccess: () => router.replace("/ready"),
  });

  return (
    <section className="space-y-6" aria-labelledby="gate-heading">
      <header className="space-y-3">
        <h1 id="gate-heading" className="font-display text-display leading-tight">
          One quick check
        </h1>
        <p className="text-body text-muted-foreground">
          We ask where you are so we only offer you what you can actually hold.
        </p>
      </header>

      {devPassthrough ? (
        <div className="space-y-3 rounded-lg border border-border border-dashed p-4">
          <p className="text-small text-muted-foreground">
            Placeholder — module 04 replaces this step with the real check.
          </p>
          <Button
            type="button"
            className="w-full"
            disabled={setRegion.isPending}
            onClick={() => setRegion.mutate({ region: "US" })}
          >
            Continue
          </Button>
        </div>
      ) : (
        <p className="text-body text-muted-foreground">
          This step is not available yet.
        </p>
      )}
    </section>
  );
}
