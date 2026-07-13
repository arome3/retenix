import type { Abi } from "viem";
import { RETENIX_POLICY_ABI } from "./retenix-policy.abi";

/**
 * RetenixPolicy deployment surface for modules 08/10/13/14 (doc 07 task 8).
 *
 * The ABI constant is code-generated from the forge artifact (see
 * contracts/script/export-abi.mjs); addresses are recorded here after each
 * deploy (also in docs/deployments.md and the worker's POLICY_CONTRACT_ADDRESS
 * env — the env value is what the worker reads at runtime; these constants are
 * the typed, importable record).
 */
export { RETENIX_POLICY_ABI };

// compile-time guarantee the generated constant is a valid viem Abi
const _abiCheck: Abi = RETENIX_POLICY_ABI;
void _abiCheck;

export const ARBITRUM_ONE_CHAIN_ID = 42161;
export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;

/** Deployed RetenixPolicy addresses per chain. Zero address = not deployed yet. */
export const POLICY_ADDRESSES = {
  // both deployed + verified 2026-07-13 (docs/deployments.md). One carries a
  // DEV agent EOA — module 08 redeploys if the KMS agent address differs.
  [ARBITRUM_ONE_CHAIN_ID]: "0x606cDadeeb7FF1e3d86C92e34b2e24dC9E9C6024",
  [ARBITRUM_SEPOLIA_CHAIN_ID]: "0x4549a91b4727537372925C8C589d9BCfF9B6c261",
} as const satisfies Record<number, `0x${string}`>;

/** The production (Arbitrum One) address — mirrors the canonical env name. */
export const POLICY_CONTRACT_ADDRESS = POLICY_ADDRESSES[ARBITRUM_ONE_CHAIN_ID];
