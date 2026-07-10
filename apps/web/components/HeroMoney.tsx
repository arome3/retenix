import { fmtUsd, splitUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

type HeroMoneyProps = Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> & {
  value: number;
  /** Balances announce politely — never assertive (DS-10 SR). */
  live?: boolean;
};

/**
 * The money moment (§3): Instrument Serif at display-xl, dollars full-size,
 * cents at 60% superscript-aligned. Doc 06 wraps this for the buying-power
 * hero (pair with useCountUp for the once-per-session count-up). Screen
 * readers get the full two-decimal amount, not the visual split.
 */
export function HeroMoney({ value, live, className, ...props }: HeroMoneyProps) {
  const { main, cents } = splitUsd(value);
  return (
    <span
      className={cn("tnum font-display text-display-xl", className)}
      {...(live ? { "aria-live": "polite" as const } : null)}
      {...props}
    >
      <span className="sr-only">{fmtUsd(value)}</span>
      <span aria-hidden="true">
        {main}
        {cents !== null && (
          <span className="align-super text-[0.6em]">{cents}</span>
        )}
      </span>
    </span>
  );
}
