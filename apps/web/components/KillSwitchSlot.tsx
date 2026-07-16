"use client";

import { ShieldOff } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

// The kill-switch header entry (C7, doc 13) — module 12 rendered the slot,
// module 13 registers the live surface. Header-persistent, never inside tabs
// (DS-4.4). The TAP is the entry AND the start of the <10 s acceptance clock
// (CONFLICTS #17): the instant is stamped here, read by the /kill surface,
// and joined with server clocks on the kill.started row (doc 16 measures it).

export const KILL_SWITCH_SLOT_ID = "kill-switch-slot";

/** sessionStorage key for the tap mark (client clock, ms). */
export const KILL_TAP_KEY = "retenix:kill-tap";

function stampTap(): void {
  try {
    sessionStorage.setItem(KILL_TAP_KEY, String(Date.now()));
    performance.mark("kill:tap");
  } catch {
    // Private mode may throw — the kill runs fine without the mark.
  }
}

export function KillSwitchSlot() {
  return (
    <div id={KILL_SWITCH_SLOT_ID} className="shrink-0">
      <Link
        href="/kill"
        aria-label="Liquidate & Lock"
        onClick={stampTap}
        className={buttonVariants({ variant: "ghost", size: "icon" })}
      >
        <ShieldOff strokeWidth={1.5} aria-hidden="true" />
      </Link>
    </div>
  );
}
