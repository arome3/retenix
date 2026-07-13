import type { Metadata } from "next";
import { ShieldOff } from "lucide-react";
import {
  BrokerAvatar,
  ContinuityAvatar,
  GuardianAvatar,
} from "@/components/avatars";
import { BuyingPowerHeader } from "@/components/BuyingPowerHeader";
import { SweepPromptCard } from "@/components/SweepPromptCard";
import { Button } from "@/components/ui/button";
import { requireSession } from "@/server/require-session";

export const metadata: Metadata = { title: "Home" };

// S2 Home (DS §8): C1 header + kill-switch entry · sweep prompt card ·
// portfolio chart (C11) + holdings (C10). Modules 06/12/13 own those pieces;
// this shell fixes the composition and the empty states so the screen is a
// designed surface before they land — never a blank page.
export default async function HomePage() {
  // The layout already gates; this read hands the client flow its EOA (the
  // sweep runner signs with the session's own key — no client-side guessing).
  const session = await requireSession();
  return (
    <div className="space-y-8 py-6">
      <header className="flex items-start justify-between gap-4">
        <BuyingPowerHeader />
        {/* TODO(doc 13): C7 arms this — the hold-to-liquidate surface. */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled
          aria-label="Kill switch (not available yet)"
        >
          <ShieldOff strokeWidth={1.5} aria-hidden="true" />
        </Button>
      </header>

      <SweepPromptCard eoa={session.eoa} />

      <section aria-labelledby="portfolio-heading" className="space-y-3">
        <h2 id="portfolio-heading" className="font-display text-h1">
          Portfolio
        </h2>
        {/* TODO(doc 12): C11 chart + C10 holdings replace this empty state. */}
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-6 shadow-soft">
          <div className="flex -space-x-1.5" aria-hidden="true">
            <BrokerAvatar size={28} />
            <GuardianAvatar size={28} />
            <ContinuityAvatar size={28} />
          </div>
          <div className="space-y-1">
            <p className="text-body">Nothing is invested yet.</p>
            <p className="text-small text-muted-foreground">
              Your staff is hired. When they start working, everything they
              hold — and the reason for every move — appears here.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
