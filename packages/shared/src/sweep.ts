/*
 * Dust-sweep + buying-power contract (doc 06) — the single source for the three
 * PROPOSED thresholds, the canonical copy strings (CONFLICTS.md #9), the network
 * display names, and the wire schemas of the two-phase `sweep.execute` payload.
 *
 * Client (ConfirmSheet → lib/sweep-runner.ts) and server (routers/sweep.ts) both
 * import these, so the signed payload the browser personal_signs can never drift
 * from what the server validates — the same discipline signing.ts established.
 * Framework-free on purpose (imported by web and worker alike).
 *
 * PROPOSED (spec-silent, doc 06 Open questions): the three constants below await
 * product-owner confirmation before W3. Change them HERE only.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// The three PROPOSED constants (doc 06 — single named constants, never inline)
// ---------------------------------------------------------------------------

/** Tokens worth less than this are not dust worth sweeping — they are noise. */
export const DUST_FLOOR_USD = 0.25;

/** The sweep prompt card renders only when found dust totals at least this. */
export const SWEEP_PROMPT_THRESHOLD_USD = 1;

/** account.summary server-side cache TTL (meets PS-F2-AC1 on refresh without hammering quotes). */
export const ACCOUNT_SUMMARY_CACHE_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Network display names (G3: exactly six; names render ONLY in breakdown
// sheets and receipts — never in decision surfaces)
// ---------------------------------------------------------------------------

/** chainId → display name for the six networks. Keys mirror @retenix/ua's
 *  RETENIX_CHAIN_IDS (shared is a leaf package and cannot import it; the unit
 *  test pins the six ids so the two lists cannot drift silently). */
export const NETWORK_NAMES: Record<number, string> = {
  1: "Ethereum",
  56: "BSC",
  8453: "Base",
  196: "X Layer",
  42161: "Arbitrum",
  101: "Solana",
};

/** Display name for a chain id; unknown ids fall back to a canon-safe label. */
export function networkName(chainId: number): string {
  return NETWORK_NAMES[chainId] ?? `Source ${chainId}`;
}

// ---------------------------------------------------------------------------
// Canonical copy (CONFLICTS.md #9 — both strings, amount/count interpolated)
// ---------------------------------------------------------------------------

// USD always two decimals ("display the zeros", doc 01); Intl, never hand-rolled.
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Decision-surface prompt copy (design-system S2 wording wins on decision
 * surfaces): `We found $23.11 in 5 places. Add it to your buying power?`
 * The card renders this text with .tnum on the interpolated numbers; its JSX
 * must compose to exactly this string (unit-tested against it).
 */
export function sweepPromptCopy(totalUsd: number, placeCount: number): string {
  const places = placeCount === 1 ? "place" : "places";
  return `We found ${usd.format(totalUsd)} in ${placeCount} ${places}. Add it to your buying power?`;
}

/**
 * Post-sweep receipt headline (receipts may name networks — product spec §6
 * beat 2): `+$23.11 rescued from 5 networks.` Stored verbatim on the
 * sweep.receipt event row; doc 11 renders it.
 */
export function sweepReceiptHeadline(succeededUsd: number, networkCount: number): string {
  // copy-canon-allow (receipt context; the scanner lives outside apps/web but the discipline is kept anyway)
  const networks = networkCount === 1 ? "network" : "networks";
  return `+${usd.format(succeededUsd)} rescued from ${networkCount} ${networks}.`;
}

// ---------------------------------------------------------------------------
// Event types (events.type strings — the doc 06 set)
// ---------------------------------------------------------------------------

export const SWEEP_EVENTS = {
  /** Phase-1 forensic record: the server-derived item list the user authorized. */
  authorized: "sweep.authorized",
  /** THE aggregate receipt — exactly one per execution (PS-F2-AC2). */
  receipt: "sweep.receipt",
  /** Per-user prompt dismissal; silence does nothing, dismissal is remembered. */
  dismissed: "sweep.dismissed",
} as const;

// ---------------------------------------------------------------------------
// Why a candidate was NOT swept (honest, human-explainable reasons)
// ---------------------------------------------------------------------------

export const SWEEP_SKIP_REASONS = [
  "source-unavailable", // RPC down/unreachable — "couldn't check 1 source"
  "source-unsupported", // RPC lacks token-indexing methods (X Layer public RPC)
  "no-price", // spam / unpriceable token
  "below-floor", // worth less than DUST_FLOOR_USD
  "fees-exceed-value", // selling $0.30 to pay $0.40 in fees is anti-user
  "quote-failed", // Particle could not quote a sell for it
] as const;
export type SweepSkipReason = (typeof SWEEP_SKIP_REASONS)[number];

// ---------------------------------------------------------------------------
// Wire schemas — two-phase sweep.execute payload (signed via lib/sign.ts)
// ---------------------------------------------------------------------------

/** Fee totals as parseFeeTotals (doc 03) returns them: plain USD numbers. */
export const feeTotalsSchema = z.object({
  gas: z.number(),
  service: z.number(),
  lp: z.number(),
  total: z.number(),
});
export type FeeTotals = z.infer<typeof feeTotalsSchema>;

/** Phase 1 — "authorize": no client input beyond intent; the server re-derives
 *  the item list itself (never trust the client's list — doc 06 security). */
export const sweepAuthorizePayloadSchema = z.object({
  phase: z.literal("authorize"),
});

export const sweepLegOutcomes = ["finished", "refunded", "failed", "timeout"] as const;

/** One executed (or attempted) leg as the CLIENT saw it. The server treats all
 *  of this as claims: usd/symbol come from the authorized row, transactionId is
 *  re-verified, outcome is re-polled server-side. */
export const sweepLegReportSchema = z.object({
  chainId: z.number().int(),
  /** Token address / mint exactly as authorized (matched case-insensitively). */
  token: z.string().min(1).max(128),
  transactionId: z.string().min(1).max(256).optional(),
  clientOutcome: z.enum(sweepLegOutcomes),
  /** Client-side parseFeeTotals of the executed quote — the honest fee source
   *  until the polled payload's shape is frozen (doc 03 OQ5 posture). */
  feesQuoted: feeTotalsSchema.optional(),
  error: z.string().max(500).optional(),
});
export type SweepLegReport = z.infer<typeof sweepLegReportSchema>;

/** Phase 2 — "report": the client returns what actually happened. */
export const sweepReportPayloadSchema = z.object({
  phase: z.literal("report"),
  executionId: z.uuid(),
  legs: z.array(sweepLegReportSchema).max(64),
});

export const sweepExecutePayloadSchema = z.discriminatedUnion("phase", [
  sweepAuthorizePayloadSchema,
  sweepReportPayloadSchema,
]);
export type SweepExecutePayload = z.infer<typeof sweepExecutePayloadSchema>;
