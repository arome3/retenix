// Deterministic receipt templates — the ONLY receipt-text source in the
// codebase (doc 08; tech spec §7). Receipts are generated from execution
// data, NEVER by the LLM. The worker (doc 08) writes these into
// executions.receipt_text; doc 11 renders them verbatim; docs 13/15 append
// their own templates HERE later — this file stays the single source.
//
// Wording law:
//   - blocked cap sentence is the product-spec form "Blocked: exceeds your
//     $50 weekly cap" (CONFLICTS #10 — never "this exceeded").
//   - refundedReceipt is used ONLY when the user's money actually came back
//     (UA REFUND statuses 8–11) or provably never left; other halts have
//     their own honest templates below.

/** Fee split in USD numbers, parsed upstream by @retenix/ua parseFeeTotals
 *  (G8). Structurally identical to that package's FeeTotalsUSD; restated here
 *  so shared carries no dependency on the UA layer. */
export interface FeeTotalsUSD {
  gas: number;
  service: number;
  lp: number;
  total: number;
}

// USD for receipt sentences: always two decimals, full precision, never
// compacted. Deliberately distinct from apps/web/lib/format.ts#fmtUsd, which
// abbreviates ≥$100K for UI surfaces — stored receipts must stay exact.
const usd2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Cap amounts read like the product spec writes them: "$50", not "$50.00".
const usd0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** "$15.00" — receipt-grade USD (two decimals, thousands separators). */
export const fmtUsd = (v: number): string => usd2.format(v);

const fmtCapUsd = (v: number): string =>
  Number.isInteger(v) ? usd0.format(v) : usd2.format(v);

/** Micro-USD (usd6) → number, local to keep this module import-free. */
const fromUsd6Local = (v: bigint): number => Number(v) / 1e6;

/** PROPOSED (spec fixes only daily/weekly/monthly): period-length word for
 *  cap sentences. Demo-scaled windows fall back to exact, honest units. */
export function periodWord(periodSecs: number): string {
  if (periodSecs === 86_400) return "daily";
  if (periodSecs === 604_800) return "weekly";
  if (periodSecs >= 2_419_200 && periodSecs <= 2_678_400) return "monthly";
  if (periodSecs % 86_400 === 0) return `${periodSecs / 86_400}-day`;
  if (periodSecs % 3_600 === 0) return `${periodSecs / 3_600}-hour`;
  return `${periodSecs}-second`;
}

/** Builds the cap phrase for blockedReceipt: "$50 weekly cap" (period cap)
 *  or "$50 per-trade cap" (per-execution cap). Caps arrive as usd6 bigints
 *  straight from the contract (CONFLICTS #11). */
export function capText(
  capUsd6: bigint,
  periodSecs: number,
  kind: "exec" | "period",
): string {
  const amount = fmtCapUsd(fromUsd6Local(capUsd6));
  return kind === "exec"
    ? `${amount} per-trade cap`
    : `${amount} ${periodWord(periodSecs)} cap`;
}

/** Contract revert names the worker maps to blocked sentences (doc 07). */
export type BlockReason =
  | "OverExecCap"
  | "OverPeriodCap"
  | "AssetNotAllowed"
  | "NotActive"
  | "NotAgent"
  | "Unknown";

/**
 * Executed buy — tech spec §7 verbatim shape. Canonical sample:
 * "Bought $15.00 of SPYx · funded from Base + Arbitrum · fees $0.14
 *  (gas $0.03, service $0.08, LP $0.03) · view onchain"
 */
export function executedReceipt(e: {
  usd: number;
  ticker: string;
  sources: string[];
  fees: FeeTotalsUSD;
}): string {
  // Sources should never be empty; if the tx detail ever omits them, the
  // receipt must still read as a sentence (PROPOSED fallback).
  const funded = e.sources.length > 0 ? e.sources.join(" + ") : "your balance";
  return `Bought ${fmtUsd(e.usd)} of ${e.ticker} · funded from ${funded} · fees ${fmtUsd(e.fees.total)} (gas ${fmtUsd(e.fees.gas)}, service ${fmtUsd(e.fees.service)}, LP ${fmtUsd(e.fees.lp)}) · view onchain`;
}

/**
 * Contract-blocked attempt. Cap reverts use the caller-built capText
 * ("$50 weekly cap" / "$50 per-trade cap"); the non-cap wordings are
 * PROPOSED (spec-silent), recorded in HANDOFF.
 */
export const blockedReceipt = (reason: BlockReason, capText: string): string => {
  switch (reason) {
    case "OverExecCap":
    case "OverPeriodCap":
      return `Blocked: exceeds your ${capText}`;
    case "AssetNotAllowed":
      return "Blocked: that asset isn't in your plan";
    case "NotActive":
      return "Blocked: this plan is no longer active";
    case "NotAgent":
      return "Blocked: not authorized by your plan";
    default:
      return "Blocked: this didn't pass your plan's checks";
  }
};

/** Failed-with-refund (DS-C4 wording): money is back with the user. */
export const refundedReceipt = (usd: number): string =>
  `Didn't complete — your ${fmtUsd(usd)} was returned`;

/**
 * Insufficient buying power → skip-and-notify (PS-F4.4 default). Canonical
 * sample: "Skipped this week's $15.00 SPYx buy — your buying power was
 * $3.12 short. I'll try again next period."
 */
const CADENCE_NOUN = {
  daily: "today",
  weekly: "this week",
  monthly: "this month",
} as const;

export function skippedReceipt(e: {
  usd: number;
  ticker: string;
  shortUsd: number;
  cadence: keyof typeof CADENCE_NOUN;
}): string {
  return `Skipped ${CADENCE_NOUN[e.cadence]}'s ${fmtUsd(e.usd)} ${e.ticker} buy — your buying power was ${fmtUsd(e.shortUsd)} short. I'll try again next period.`;
}

/** PROPOSED: plan revoked/paused after the onchain approval but before the
 *  buy went out — nothing left the account, so "was returned" would lie. */
export const revokedReceipt = (
  usd: number,
  ticker: string,
  cause: "revoked" | "paused" = "revoked",
): string =>
  `Cancelled — this plan was ${cause} before your ${fmtUsd(usd)} ${ticker} buy went out`;

/** PROPOSED: buy submitted but not confirmed within the poll ceiling; a
 *  human reconciles. Deliberately NOT the refund wording — funds may still
 *  be in flight. */
export const unresolvedReceipt = (usd: number, ticker: string): string =>
  `Still settling — your ${fmtUsd(usd)} ${ticker} buy hasn't confirmed yet. We're checking on it.`;

// --- plan lifecycle receipts (module 10, PROPOSED copy — doc 10 seeds the
// --- "hired"/"dismissed" sentences; agent voice, doc 01) ---

const CADENCE_EVERY = {
  daily: "every day",
  weekly: "every week",
  monthly: "every month",
} as const;

/** "SPYx, TSLAx and SOL" — receipt-grade list joining. */
function tickerList(tickers: readonly string[]): string {
  if (tickers.length <= 1) return tickers[0] ?? "";
  return `${tickers.slice(0, -1).join(", ")} and ${tickers[tickers.length - 1]}`;
}

/** Activation receipt (doc 10 step 4, PROPOSED): "Your Broker is hired — …". */
export function brokerHiredReceipt(e: {
  amountUsd: number;
  cadence: keyof typeof CADENCE_EVERY;
  tickers: readonly string[];
}): string {
  return `Your Broker is hired — ${fmtUsd(e.amountUsd)} ${CADENCE_EVERY[e.cadence]} across ${tickerList(e.tickers)}.`;
}

/** Guardian activation receipt (PROPOSED, same register). */
export function guardianHiredReceipt(e: {
  weeklyCapUsd?: number;
  maxDrawdownPct?: number;
}): string {
  const clauses: string[] = [];
  if (e.weeklyCapUsd !== undefined) {
    clauses.push(`never more than ${fmtUsd(e.weeklyCapUsd)} a week`);
  }
  if (e.maxDrawdownPct !== undefined) {
    clauses.push(`stops everything at ${e.maxDrawdownPct}% down`);
  }
  return `Your Guardian is on duty — ${clauses.join(" · ")}.`;
}

const AGENT_TITLE = {
  broker: "Broker",
  guardian: "Guardian",
  legacy: "Continuity plan",
} as const;

/** Revoke receipt (doc 10, seeded copy: "…it can no longer act."). */
export const planDismissedReceipt = (
  kind: keyof typeof AGENT_TITLE,
): string => `Your ${AGENT_TITLE[kind]} was dismissed — it can no longer act.`;

/** Pause/resume receipts (PROPOSED). Pause is an operational stop (the worker
 *  stops scheduling); revoke is the onchain kill — the copy keeps them apart. */
export const planPausedReceipt = (kind: keyof typeof AGENT_TITLE): string =>
  `Your ${AGENT_TITLE[kind]} is paused — nothing runs until you resume it.`;
export const planResumedReceipt = (kind: keyof typeof AGENT_TITLE): string =>
  `Your ${AGENT_TITLE[kind]} is back on duty.`;

// --- kill-switch receipts (module 13; doc 13's aggregate wording is PROPOSED
// --- and implemented verbatim — never redesigned; flagged in HANDOFF) ---

/** Per-leg settled sell. Number-free like module 12's sell.receipt — the
 *  aggregate carries the honest totals; per-leg USD lives in the leg detail. */
export const killLegSoldReceipt = (ticker: string): string =>
  `Sold ${ticker} — now USDC in your balance.`;

/** Per-leg settled convert (non-USDC primary → USDC). */
export const killLegConvertedReceipt = (symbol: string): string =>
  `Converted ${symbol} to USDC in your balance.`;

/** Per-leg failure — honest, retry lives on the surface (PS-F6-AC2). */
export const killLegFailedReceipt = (symbol: string): string =>
  `Couldn't liquidate ${symbol} — you can retry.`;

/** Per-leg server-unverifiable claim (sweep's honesty posture). */
export const killLegUnverifiedReceipt = (symbol: string): string =>
  `${symbol} liquidation couldn't be verified — you can retry.`;

/**
 * THE aggregate kill receipt (event kill.receipt) — doc 13 PROPOSED wording,
 * honest counts: "Liquidated 4 of 5 positions to USDC · all agents revoked ·
 * 1 leg needs retry". Refunded/unverified legs count as needing retry (the
 * position is still held). A failed revoke never claims "revoked".
 */
export function killReceiptText(e: {
  liquidated: number;
  total: number;
  retryable: number;
  revoked: boolean;
}): string {
  const revokeClause = e.revoked
    ? "all agents revoked"
    : "agent revocation still pending";
  if (e.total === 0) {
    // Zero-position kill (all-USDC account): still a real kill — PROPOSED.
    return `Nothing to liquidate — ${revokeClause}`;
  }
  const head = `Liquidated ${e.liquidated} of ${e.total} positions to USDC · ${revokeClause}`;
  if (e.retryable <= 0) return head;
  const legs = e.retryable === 1 ? "1 leg needs retry" : `${e.retryable} legs need retry`;
  return `${head} · ${legs}`;
}
