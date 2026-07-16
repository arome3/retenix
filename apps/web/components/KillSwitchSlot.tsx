import { ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";

// The kill-switch header slot (doc 12 renders the SLOT; doc 13 registers the
// surface). Header-persistent, never inside tabs (DS-4.4 / doc 01 shell
// rule). Module 13's contract, recorded in HANDOFF: replace the placeholder
// button below with C7's live entry (keeping an icon-sized control with an
// accessible name), or portal against KILL_SWITCH_SLOT_ID and hide the
// element marked data-kill-switch-placeholder. Nothing here may gain
// kill-switch BEHAVIOR under doc 12 — the placeholder stays disabled.

export const KILL_SWITCH_SLOT_ID = "kill-switch-slot";

export function KillSwitchSlot() {
  return (
    <div id={KILL_SWITCH_SLOT_ID} className="shrink-0">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled
        data-kill-switch-placeholder
        aria-label="Kill switch (not available yet)"
      >
        <ShieldOff strokeWidth={1.5} aria-hidden="true" />
      </Button>
    </div>
  );
}
