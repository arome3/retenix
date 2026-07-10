import { cn } from "@/lib/utils";

type NumProps = React.HTMLAttributes<HTMLSpanElement> & {
  /** Balances that update in place announce politely — never assertive (DS-10 SR). */
  live?: boolean;
};

/**
 * Every mutable number renders through this so it picks up tabular lining
 * figures (G13): balances, deltas, fees, table cells, countdowns. Raw
 * `{money}` interpolation in JSX is a review blocker — see the checklist in
 * apps/web/README.md.
 */
export function Num({ live, className, children, ...props }: NumProps) {
  return (
    <span
      className={cn("tnum", className)}
      {...(live ? { "aria-live": "polite" as const } : null)}
      {...props}
    >
      {children}
    </span>
  );
}
