/**
 * EVM endpoint table for the Magic browser SDK.
 *
 * PROPOSED (spec-silent, doc 02): doc 02 names five EVM `switchChain` targets —
 * 1, 8453, 42161, 56, 196 — but not their RPC endpoints. Solana is reached only
 * through the UA SDK (doc 03); Magic holds EVM keys and does EVM signing only,
 * so there is no `101` entry here.
 *
 * The endpoints are constants rather than env values on purpose: doc 00's
 * canonical `RPC_URL_*` names are worker-side, and the browser must never read
 * them. Magic uses these endpoints for read calls (e.g. the account nonce when
 * `sign7702Authorization` is called without one). Every key operation happens
 * inside Magic's TEE, so an endpoint is not a trust boundary.
 *
 * Shape is `EVMNetworkConfig` from `@magic-ext/evm@1.7.0`'s typings (the package
 * does not re-export the type from its entrypoint, so it is restated here):
 *   { rpcUrl: string; chainId?: number; chainType?: EthChainType; default?: boolean }
 */
export type EvmEndpoint = {
  rpcUrl: string;
  chainId: number;
  /** Selects the endpoint Magic starts on. Exactly one entry sets this. */
  default?: boolean;
};

export const ETHEREUM_MAINNET = 1;
export const BSC_MAINNET = 56;
export const XLAYER_MAINNET = 196;
export const BASE_MAINNET = 8453;
export const ARBITRUM_MAINNET_ONE = 42161;

/** Arbitrum One hosts RetenixPolicy (doc 07) and is the gate-G1 smoke target. */
export const DEFAULT_EVM_CHAIN_ID = ARBITRUM_MAINNET_ONE;

export const EVM_ENDPOINTS: EvmEndpoint[] = [
  { chainId: ETHEREUM_MAINNET, rpcUrl: "https://ethereum-rpc.publicnode.com" },
  { chainId: BASE_MAINNET, rpcUrl: "https://mainnet.base.org" },
  { chainId: ARBITRUM_MAINNET_ONE, rpcUrl: "https://arb1.arbitrum.io/rpc", default: true },
  { chainId: BSC_MAINNET, rpcUrl: "https://bsc-dataseed.bnbchain.org" },
  { chainId: XLAYER_MAINNET, rpcUrl: "https://rpc.xlayer.tech" },
];

export const DEFAULT_EVM_ENDPOINT: EvmEndpoint =
  EVM_ENDPOINTS.find((n) => n.default) ?? EVM_ENDPOINTS[0];
