// C3's "Can never" panel (doc 10 task 1) — the muted panel that makes a card's
// bounds legible. Copy is VERBATIM (design system §7 / doc 10); the sanctioned
// "enforced on-chain" trust-proof phrase (CONFLICTS #15) appears here and only
// here — copy-canon allowlists it.

/** Broker/Guardian "Can never" clauses (verbatim). */
const BROKER_GUARDIAN = [
  "Can never exceed your caps — enforced on-chain",
  "Can never touch other assets",
  "Can never block your kill switch",
] as const;

/** Legacy variant (PROPOSED, same register — doc 10 task 1). */
const LEGACY = [
  "Can never move anything while you're active",
  "Can never skip the waiting period",
  "Can never change your beneficiary",
] as const;

export function CanNeverPanel({
  variant,
}: {
  variant: "broker" | "guardian" | "legacy";
}) {
  const clauses = variant === "legacy" ? LEGACY : BROKER_GUARDIAN;
  return (
    <div className="rounded-md bg-muted/60 px-3 py-2.5">
      <ul className="flex flex-col gap-1 text-small text-muted-foreground">
        {clauses.map((c) => (
          <li key={c} className="flex gap-2">
            <span aria-hidden="true" className="text-agent">
              ✓
            </span>
            <span>{c}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
