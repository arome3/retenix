import type { Abi } from "viem";
import { RETENIX_CLAIM_ABI } from "./retenix-claim.abi";
import { RETENIX_POLICY_ABI } from "./retenix-policy.abi";

/**
 * RetenixPolicy/RetenixClaim deployment surface for modules 08/10/13/14
 * (doc 07 task 8, doc 14 task 2).
 *
 * The ABI constants are code-generated from the forge artifacts (see
 * contracts/script/export-abi.mjs); addresses are recorded here after each
 * deploy (also in docs/deployments.md and the worker's POLICY_CONTRACT_ADDRESS
 * / CLAIM_DELEGATE_ADDRESS_* env — the env values are what services read at
 * runtime; these constants are the typed, importable record).
 */
export { RETENIX_CLAIM_ABI, RETENIX_POLICY_ABI };

// compile-time guarantee the generated constants are valid viem Abis
const _abiCheck: Abi = RETENIX_POLICY_ABI;
void _abiCheck;
const _claimAbiCheck: Abi = RETENIX_CLAIM_ABI;
void _claimAbiCheck;

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

/** The 5 estate-covered EVM chains (doc 14 — Solana excluded: no 7702 there). */
export const ESTATE_CHAIN_IDS = [1, 56, 8453, 196, 42161] as const;
export type EstateChainId = (typeof ESTATE_CHAIN_IDS)[number];

/**
 * Deployed RetenixClaim delegate addresses per chain (doc 14 task 2 — one per
 * estate chain). Zero address = not deployed yet (owner runs
 * contracts/script/DeployClaim.s.sol and records here + env + deployments.md).
 * keeper/policy are IMMUTABLE in the delegate — a keeper rotation means a
 * redeploy on every chain.
 */
export const CLAIM_ADDRESSES = {
  1: "0x0000000000000000000000000000000000000000",
  56: "0x0000000000000000000000000000000000000000",
  8453: "0x0000000000000000000000000000000000000000",
  196: "0x0000000000000000000000000000000000000000",
  // deployed + verified 2026-07-17 (docs/deployments.md); keeper = the DEV
  // deployer EOA (immutable — KMS keeper means redeploy, module 08 precedent)
  [ARBITRUM_ONE_CHAIN_ID]: "0x92427d60cda5f63740d95Ad972dFA5A115AdD8d0",
} as const satisfies Record<EstateChainId, `0x${string}`>;

/** Rehearsal deployment (not an estate chain — Sepolia integration runs only). */
export const CLAIM_ADDRESS_ARBITRUM_SEPOLIA =
  "0xBc5D4524518E1af5cbFcFbC7fF0534fa4E59F94b";
