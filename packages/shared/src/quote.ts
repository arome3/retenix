// Quote-sanity bounds (doc 08 preflight, extended by doc 20).
//
// The worker rejects a buy whose quoted fees exceed max(floor, 5% of the leg)
// as a bad/rugged quote. The *floor* is per-chain: a flat $0.50 is a Solana-era
// assumption — a $5 gold leg on Ethereum mainnet can legitimately cost more than
// that in gas alone, and a flat floor would fail the demo's gold leg as a false
// "quote-sanity" reject. The proportional 5% rule still catches a genuinely
// rugged quote on any chain; slippage stays pinned at 100 bps in @retenix/ua.
//
// ⚠ PROPOSED (doc 20, decision 4): the chain-1 floor is a starting value —
// G-R1's live PAXG buy MEASURES real Ethereum fees and calibrates it. The demo
// intentionally uses small sizes, and the honesty of a visibly higher Ethereum
// fee split (G8) is a feature, never suppressed. Single-sourced here; the
// executor imports this and never hardcodes its own number.

/** Default quote-fee floor (USD) for chains where gas is cheap (Solana, L2s). */
export const DEFAULT_QUOTE_FEE_FLOOR_USD = 0.5;

/** Per-chain overrides. Ethereum mainnet (1) legitimately costs more per tx. */
export const QUOTE_FEE_FLOOR_USD_BY_CHAIN: Readonly<Record<number, number>> = {
  1: 3.0, // Ethereum mainnet — PROPOSED, calibrate from G-R1 (doc 20)
};

/** The USD fee floor below which a quote is never rejected as too-expensive. */
export function quoteFeeFloorUsd(chainId: number): number {
  return QUOTE_FEE_FLOOR_USD_BY_CHAIN[chainId] ?? DEFAULT_QUOTE_FEE_FLOOR_USD;
}
