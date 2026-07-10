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
