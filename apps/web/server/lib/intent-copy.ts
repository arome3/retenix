// Intent-parse response copy (doc 09) — a DECISION surface, so the banned
// vocabulary (G12) applies fully. Every user-visible string this route can
// emit lives in this one file for copy review.
import { eligibleAssets, type AssetAccess } from "@retenix/registry";

/** The fixed confidence line — never a fabricated numeric confidence score. */
export const CONFIDENCE_NOTE = "Here's what I understood — check the numbers";

export interface IntentDecline {
  message: string;
  suggestions: string[];
}

/**
 * Region-aware example phrasings (PROPOSED; same register as the canonical
 * copy). Tickers come from the region's own registry slice so a blocked-region
 * user is never nudged toward an asset the gate hides from them.
 */
export function intentSuggestions(
  region: string,
  access: AssetAccess = {},
): string[] {
  const assets = eligibleAssets(region, access);
  const ticker = (id: string) => assets.find((a) => a.id === id)?.ticker;
  const sol = ticker("sol") ?? "SOL";
  const eth = ticker("eth") ?? "ETH";
  const spy = ticker("spyx");
  const tsla = ticker("tslax");
  const qqq = ticker("qqqx");

  const basketLine =
    spy && tsla
      ? `Invest $25 every week: 60% ${spy}, 30% ${tsla}, 10% ${sol}.`
      : `Invest $25 a week: 70% ${sol}, 30% ${eth}.`;
  const singleLine = qqq
    ? `Put $100 a month into ${qqq}.`
    : `Put $100 a month into ${sol}.`;

  return [
    basketLine,
    singleLine,
    "Cap me at $200 a week.",
    "If I'm inactive for a year, everything goes to ada@example.com.",
  ];
}

/**
 * The model returned no usable policy intent (empty object, or nothing valid
 * remained after the deterministic drops). Canonical copy, verbatim (doc 09 /
 * C5 escalation copy).
 */
export function declineUnparseable(region: string): IntentDecline {
  return {
    message:
      "I didn't want to guess. Try: 'Invest $25 weekly into SPYx and SOL, stop if I'm down 15%.'",
    suggestions: intentSuggestions(region),
  };
}

/**
 * `NoObjectGeneratedError` — the model produced something the schema wall
 * refused. Graceful re-prompt (guardrail 5), never a stack trace.
 */
export function declineReprompt(region: string): IntentDecline {
  return {
    message:
      "That didn't come through clearly. Say it another way — one sentence about what to invest, what to cap, or who inherits works best.",
    suggestions: intentSuggestions(region),
  };
}

/**
 * Timeout or upstream outage. Parsing is never on an execution path, so this
 * only degrades UX — offer the manual path (doc 10 owns the "build it by
 * hand" link target).
 */
export function declineUnavailable(region: string): IntentDecline {
  return {
    message:
      "Drafting isn't available right now. Try again in a moment — or build it by hand.",
    suggestions: intentSuggestions(region),
  };
}

/** Rate-limit message (thrown as TOO_MANY_REQUESTS, rendered by the client). */
export const RATE_LIMIT_MESSAGE =
  "That's a lot of drafts at once — give it a minute and try again.";
