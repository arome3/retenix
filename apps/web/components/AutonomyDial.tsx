"use client";

// C3's autonomy dial (doc 10 task 2) — a 4-stop radio group, keyboard-operable,
// ≥24px targets. Positions and behavior are PROPOSED, implemented exactly as
// documented (never redesigned). Dial changes are signed mutations
// (plans.setAutonomy) but NOT contract writes — the contract enforces bounds;
// autonomy is a server-side execution mode within them.
import { AUTONOMY_LABELS, AUTONOMY_LEVELS, type Autonomy } from "@retenix/shared";

/** One-line description of what each stop does (decision-surface copy, G12). */
const HINT: Record<Autonomy, string> = {
  observe: "Watches only — tells you what it would have done.",
  propose: "Lines up each buy for you to confirm.",
  confirm: "Lines up each buy and reminds you on Home.",
  auto: "Runs on its own, inside your caps.",
};

export function AutonomyDial({
  value,
  onChange,
  disabled,
  name,
}: {
  value: Autonomy;
  onChange: (next: Autonomy) => void;
  disabled?: boolean;
  /** Unique radiogroup name (one dial per card). */
  name: string;
}) {
  return (
    <fieldset
      className="flex flex-col gap-1.5"
      role="radiogroup"
      aria-label="How much the agent may do on its own"
    >
      {AUTONOMY_LEVELS.map((level) => {
        const checked = value === level;
        return (
          <label
            key={level}
            className="flex min-h-6 cursor-pointer items-start gap-2.5 rounded-md px-1 py-1 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
          >
            <input
              type="radio"
              name={name}
              value={level}
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(level)}
              className="mt-0.5 size-4 accent-[var(--color-agent)]"
            />
            <span className="flex flex-col">
              <span
                className={
                  checked
                    ? "text-small font-medium text-foreground"
                    : "text-small text-foreground"
                }
              >
                {AUTONOMY_LABELS[level]}
              </span>
              <span className="text-caption text-muted-foreground">
                {HINT[level]}
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
