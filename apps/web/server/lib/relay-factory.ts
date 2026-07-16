// Relay indirection seam (doc 10) — the plans router calls the chain through
// this factory, and route tests replace it (the parse-intent.ts precedent) so
// they exercise the real DB writes and validation without a live relayer.
import { RelayClient } from "./relay";

export interface PlanRelay {
  domain: { chainId: number; contract: string };
  authNonce(owner: string): Promise<bigint>;
  agentAddress(): Promise<string>;
  buildCreatePlanDigest(args: {
    capPerExec: bigint;
    capPerPeriod: bigint;
    periodSecs: number;
    assetListHash: string;
    nonce: bigint;
  }): Promise<string>;
  createPlan(args: {
    owner: string;
    capPerExec: bigint;
    capPerPeriod: bigint;
    periodSecs: number;
    assetListHash: string;
    assetIds: string[];
    nonce: bigint;
    ownerSig: string;
  }): Promise<{ txHash: string; planId: bigint }>;
  revokePlanFor(args: {
    owner: string;
    planId: bigint;
    nonce: bigint;
    ownerSig: string;
  }): Promise<{ txHash: string }>;
  /** Module 13: verify a revokeAll owner-signature (pre-submit guard). */
  verifyRevokeAll(owner: string, nonce: bigint, ownerSig: string): boolean;
  /** Module 13: relay revokeAll — send-only (see RelayClient.revokeAll). */
  revokeAll(args: {
    owner: string;
    nonce: bigint;
    ownerSig: string;
  }): Promise<{ txHash: string }>;
  /** Module 13: lazy confirmation read for the revoked flag. */
  txStatus(txHash: string): Promise<"pending" | "confirmed" | "failed">;
}

/** Default: the real chain client. Overridden in tests via setPlanRelayFactory. */
let factory: () => PlanRelay = () => new RelayClient();

export function getPlanRelay(): PlanRelay {
  return factory();
}

/** Test seam. */
export function setPlanRelayFactory(f: () => PlanRelay): void {
  factory = f;
}
export function resetPlanRelayFactory(): void {
  factory = () => new RelayClient();
}
