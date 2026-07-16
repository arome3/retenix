import type { Metadata } from "next";
import { BuyingPowerHeader } from "@/components/BuyingPowerHeader";
import { KillSwitchSlot } from "@/components/KillSwitchSlot";
import { PortfolioSection } from "@/components/PortfolioSection";
import { SweepPromptCard } from "@/components/SweepPromptCard";
import { requireSession } from "@/server/require-session";

export const metadata: Metadata = { title: "Home" };

// S2 Home (doc 12, DS §8) — assembly order is spec-fixed: C1 header +
// kill-switch slot (doc 13 registers the surface; the slot renders here) →
// dust-sweep prompt (doc 06's card, first session) → C11 chart → C9 ring →
// C10 holdings (PortfolioSection) → mini-feed. One screen answers: what am
// I worth, how has it moved, what do I hold, what did it cost me, what's my
// mix — with zero chain vocabulary (G12/G3: Home never names networks).
export default async function HomePage() {
  // The layout already gates; this read hands the sweep runner its EOA (it
  // signs with the session's own key — no client-side guessing).
  const session = await requireSession();
  return (
    <div className="space-y-8 py-6">
      <header className="flex items-start justify-between gap-4">
        <BuyingPowerHeader />
        <KillSwitchSlot />
      </header>

      <SweepPromptCard eoa={session.eoa} />

      <section aria-labelledby="portfolio-heading" className="space-y-4">
        <h2 id="portfolio-heading" className="font-display text-h1">
          Portfolio
        </h2>
        <PortfolioSection />
      </section>
    </div>
  );
}
