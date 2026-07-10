"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { magic } from "@/lib/magic";

/*
 * C14 KeyExportFlow (design system §7) — the product's proof of self-custody.
 *
 * revealEVMPrivateKey opens a modal Magic renders and Magic owns. The key is
 * never returned to this code, never held in state, never logged, and never
 * crosses a Retenix host. Nothing below may catch a rejection and print it,
 * because a printed rejection is the one place a key could leak.
 *
 * There is deliberately no "email me my key" affordance. Retenix has nothing to
 * send, which is the entire point.
 */
type Status = "idle" | "revealing" | "revealed" | "dismissed";

export function KeyExportFlow() {
  const [status, setStatus] = useState<Status>("idle");

  async function reveal() {
    setStatus("revealing");
    try {
      await magic.user.revealEVMPrivateKey();
      setStatus("revealed");
    } catch {
      // Intentionally opaque: the rejection is never inspected or surfaced.
      setStatus("dismissed");
    }
  }

  return (
    <section className="space-y-6" aria-labelledby="export-heading">
      <header className="space-y-3">
        <h1 id="export-heading" className="font-display text-display leading-tight">
          Export your key
        </h1>
        <p className="text-body text-muted-foreground">
          Your account is a standard address. Take it anywhere — Retenix works for
          you, not the other way around.
        </p>
      </header>

      <p className="text-small text-muted-foreground">
        Your key is shown to you and to no one else. Retenix never receives it, so
        there is nothing here for us to store, send, or lose.
      </p>

      <Button
        type="button"
        className="w-full"
        onClick={reveal}
        disabled={status === "revealing"}
      >
        {status === "revealing" ? "Opening…" : "Show my key"}
      </Button>

      <p aria-live="polite" className="text-small text-muted-foreground">
        {status === "revealed"
          ? "That key was shown only to you."
          : status === "dismissed"
            ? "Nothing was shown. You can try again whenever you like."
            : ""}
      </p>
    </section>
  );
}
