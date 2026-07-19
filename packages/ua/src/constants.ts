// packages/ua/src/constants.ts — canonical chain/asset constants.
//
// Re-exported from the SDK so NO downstream code imports the UA SDK directly
// (module 03 hard constraint). This is the single source of truth for chain ids
// and token types across the whole app.
import {
  CHAIN_ID,
  SUPPORTED_TOKEN_TYPE,
  UA_TRANSACTION_STATUS,
  SOLANA_ACCOUNT_INDEX,
  UNIVERSAL_ACCOUNT_VERSION,
  ZeroAddress,
  SOLANA_NATIVE_ADDRESS_ZERO,
  SUPPORTED_PRIMARY_TOKENS,
  UNIVERSAL_ACCOUNT_VERSION_V2_SUPPORTED_CHAIN_IDS,
} from "@particle-network/universal-account-sdk";

export {
  CHAIN_ID,
  SUPPORTED_TOKEN_TYPE,
  UA_TRANSACTION_STATUS,
  SOLANA_ACCOUNT_INDEX,
  UNIVERSAL_ACCOUNT_VERSION,
  ZeroAddress,
  SOLANA_NATIVE_ADDRESS_ZERO,
  SUPPORTED_PRIMARY_TOKENS,
  UNIVERSAL_ACCOUNT_VERSION_V2_SUPPORTED_CHAIN_IDS,
};

// G3: exactly SIX networks — never 16. All marketing copy and UI say "6 networks";
// V1's "16+ chains" figures are stale. Order matches tech spec §3.
export const RETENIX_CHAIN_IDS = [
  CHAIN_ID.SOLANA_MAINNET, // 101
  CHAIN_ID.ETHEREUM_MAINNET, // 1
  CHAIN_ID.BSC_MAINNET, // 56
  CHAIN_ID.BASE_MAINNET, // 8453
  CHAIN_ID.XLAYER_MAINNET, // 196
  CHAIN_ID.ARBITRUM_MAINNET_ONE, // 42161
] as const;

// G3: primary assets — eth, usdt, usdc, bnb, sol (BTC removed in v2).
export const RETENIX_PRIMARY_ASSETS = [
  SUPPORTED_TOKEN_TYPE.ETH,
  SUPPORTED_TOKEN_TYPE.USDT,
  SUPPORTED_TOKEN_TYPE.USDC,
  SUPPORTED_TOKEN_TYPE.BNB,
  SUPPORTED_TOKEN_TYPE.SOL,
] as const;

// The one number every marketing/UI surface must show for network count (G3).
export const RETENIX_NETWORK_COUNT = 6 as const;

/** True iff `chainId` is one of the six UA v2 networks Retenix supports. */
export function isSupportedChain(chainId: number): boolean {
  return (RETENIX_CHAIN_IDS as readonly number[]).includes(chainId);
}

// --- Withdraw network derivation (doc 15) ---------------------------------
//
// Withdraw (the single sanctioned network-choice surface, CONFLICTS #16) may
// only offer networks where the chosen asset actually exists as a primary
// token. Derived from the SDK's own SUPPORTED_PRIMARY_TOKENS — never a
// hand-pinned list — and returned in tech-spec §3 chain order so the UI list
// is stable. X Layer carries zero primary tokens in 2.0.3, so it never
// appears; if a future SDK adds one, the list updates itself.

/** Chain ids (spec §3 order) where `asset` exists as a primary token. */
export function networksForAsset(asset: SUPPORTED_TOKEN_TYPE): number[] {
  const chains = new Set<number>();
  for (const t of SUPPORTED_PRIMARY_TOKENS) {
    if (t.type === asset) chains.add(t.chainId);
  }
  return (RETENIX_CHAIN_IDS as readonly number[]).filter((id) => chains.has(id));
}

/** The primary-token record for (asset, chainId), or null when that asset
 *  does not exist there — callers must treat null as "invalid pair". */
export function primaryTokenFor(
  asset: SUPPORTED_TOKEN_TYPE,
  chainId: number,
): (typeof SUPPORTED_PRIMARY_TOKENS)[number] | null {
  return (
    SUPPORTED_PRIMARY_TOKENS.find((t) => t.type === asset && t.chainId === chainId) ??
    null
  );
}
