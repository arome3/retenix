// Plan relay client (doc 10 task 5) — the gas-sponsored bridge between a
// user's owner-signature and RetenixPolicy. The relayer pays Arbitrum gas; it
// can only submit OWNER-SIGNED payloads (the contract recovers the signature
// against the owner arg over the doc-07 digest), so a compromised relayer
// cannot forge a plan: it can grief by withholding, never by fabricating.
//
// Digests come from @retenix/shared/policy-digest (the SAME builders the
// Solidity cross-tests use — never re-encode here). This client only READS the
// nonce, VERIFIES the client's signature locally before spending gas, and
// SUBMITS.
import {
  POLICY_ADDRESSES,
  RETENIX_POLICY_ABI,
  createPlanDigest,
  revokeAllDigest,
  revokePlanDigest,
} from "@retenix/shared";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  getBytes,
  hashMessage,
  isHexString,
  recoverAddress,
  type TransactionReceipt,
} from "ethers";
import { env } from "@/env";

const ARBITRUM_ONE = 42161;

/** RetenixPolicy domain with a concrete numeric chainId (PolicyDomain widens
 *  chainId to number|bigint for the digest encoders; the relay needs number). */
export interface RelayDomain {
  chainId: number;
  contract: string;
}

/** The deployed RetenixPolicy address for the configured chain (doc 07's
 *  single source — never hardcode an address here). */
export function policyDomain(): RelayDomain {
  const chainId = Number(env.POLICY_CHAIN_ID) as keyof typeof POLICY_ADDRESSES;
  return { chainId, contract: POLICY_ADDRESSES[chainId] };
}

function rpcUrl(chainId: number): string {
  if (chainId === ARBITRUM_ONE) return env.RPC_URL_ARBITRUM;
  const sepolia = env.RPC_URL_ARBITRUM_SEPOLIA;
  if (!sepolia) {
    throw new Error(
      "[relay] POLICY_CHAIN_ID=421614 requires RPC_URL_ARBITRUM_SEPOLIA",
    );
  }
  return sepolia;
}

/** Recover the address that personal_sign'd a 32-byte policy digest. */
export function recoverDigestSigner(digest: string, signature: string): string {
  // personal_sign hashes getBytes(digest) under the EIP-191 prefix; the
  // contract's _recover does the same. Mirror it exactly.
  return recoverAddress(hashMessage(getBytes(digest)), signature);
}

export interface RelayResult {
  txHash: string;
  receipt: TransactionReceipt;
}

/**
 * The relay client. Constructed per request from the typed env; validates the
 * relayer key shape here (not in env.ts) so a placeholder-cred boot stays
 * green — the failure lands only when a relay is actually attempted (module
 * 08's degraded-boot convention).
 */
export class RelayClient {
  readonly domain: RelayDomain;
  private readonly provider: JsonRpcProvider;
  /** Read-only contract (provider-bound) — reads never need the signing key. */
  private readonly reader: Contract;
  /** Write contract, lazily created (needs the relayer key). */
  private writer?: Contract;

  constructor() {
    this.domain = policyDomain();
    // Reads (nonce, agent, digest building) work with only a provider, so a
    // placeholder-cred boot can still PREPARE an activation; the key check is
    // deferred to write time (module 08's degraded-boot convention).
    this.provider = new JsonRpcProvider(rpcUrl(this.domain.chainId));
    this.reader = new Contract(
      this.domain.contract,
      RETENIX_POLICY_ABI,
      this.provider,
    );
  }

  private writeContract(): Contract {
    if (this.writer) return this.writer;
    const key = env.RELAYER_PRIVATE_KEY;
    if (!isHexString(key, 32)) {
      throw new Error(
        "[relay] RELAYER_PRIVATE_KEY is not a 32-byte hex key — set a funded " +
          "relayer key (owner-action, HANDOFF module 10)",
      );
    }
    this.writer = new Contract(
      this.domain.contract,
      RETENIX_POLICY_ABI,
      new Wallet(key, this.provider),
    );
    return this.writer;
  }

  /** authNonces(owner) — the next sequential nonce for a relayed owner op. */
  async authNonce(owner: string): Promise<bigint> {
    return (await this.reader.authNonces(owner)) as bigint;
  }

  /** The contract's immutable agent EOA (needed to build createPlan digests). */
  async agentAddress(): Promise<string> {
    return (await this.reader.agent()) as string;
  }

  /** Build the createPlan digest the owner must personal_sign (client preview). */
  async buildCreatePlanDigest(args: {
    capPerExec: bigint;
    capPerPeriod: bigint;
    periodSecs: number;
    assetListHash: string;
    nonce: bigint;
  }): Promise<string> {
    return createPlanDigest(this.domain, {
      agent: await this.agentAddress(),
      capPerExec: args.capPerExec,
      capPerPeriod: args.capPerPeriod,
      periodSecs: args.periodSecs,
      assetListHash: args.assetListHash,
      nonce: args.nonce,
    });
  }

  /**
   * Relay createPlan. Re-derives the digest from the SAME params the caller
   * claims to have signed and verifies the owner's signature locally before
   * spending gas — so a mismatch fails fast, off-chain, and the on-chain
   * createPlan verification is the backstop, not the first line.
   */
  async createPlan(args: {
    owner: string;
    capPerExec: bigint;
    capPerPeriod: bigint;
    periodSecs: number;
    assetListHash: string;
    assetIds: string[];
    nonce: bigint;
    ownerSig: string;
  }): Promise<RelayResult & { planId: bigint }> {
    const digest = await this.buildCreatePlanDigest(args);
    this.assertSigner(digest, args.ownerSig, args.owner, "createPlan");

    const tx = await this.writeContract().createPlan(
      args.owner,
      args.capPerExec,
      args.capPerPeriod,
      args.periodSecs,
      args.assetListHash,
      args.assetIds,
      args.nonce,
      args.ownerSig,
    );
    const receipt = (await tx.wait()) as TransactionReceipt;
    const planId = this.extractPlanId(receipt);
    return { txHash: receipt.hash, receipt, planId };
  }

  /** Relay revokePlanFor (the gas-sponsored path; direct revokePlan is the
   *  fallback when the relayer is down — the card owner can send it itself). */
  async revokePlanFor(args: {
    owner: string;
    planId: bigint;
    nonce: bigint;
    ownerSig: string;
  }): Promise<RelayResult> {
    const digest = revokePlanDigest(this.domain, {
      id: args.planId,
      nonce: args.nonce,
    });
    this.assertSigner(digest, args.ownerSig, args.owner, "revokePlan");
    const tx = await this.writeContract().revokePlanFor(
      args.planId,
      args.nonce,
      args.ownerSig,
    );
    const receipt = (await tx.wait()) as TransactionReceipt;
    return { txHash: receipt.hash, receipt };
  }

  /** revokeAll digest verification — the pre-submit guard for revokeAll(). */
  verifyRevokeAll(owner: string, nonce: bigint, ownerSig: string): boolean {
    const digest = revokeAllDigest(this.domain, { nonce });
    return recoverDigestSigner(digest, ownerSig).toLowerCase() === owner.toLowerCase();
  }

  /**
   * Relay revokeAll (module 13's kill switch) — SEND-ONLY, deliberately
   * unlike revokePlanFor: kill.execute must return the liquidation work items
   * the instant authority revocation is in flight, and a congested RPC's
   * tx.wait() would hold the legs hostage (inverting doc 13's "authority dies
   * fastest, legs start immediately" ordering). Confirmation is read lazily
   * via txStatus(); the contract call is idempotent over already-revoked
   * plans, so a duplicate submission converges.
   */
  async revokeAll(args: {
    owner: string;
    nonce: bigint;
    ownerSig: string;
  }): Promise<{ txHash: string }> {
    const digest = revokeAllDigest(this.domain, { nonce: args.nonce });
    this.assertSigner(digest, args.ownerSig, args.owner, "revokeAll");
    const tx = await this.writeContract().revokeAll(
      args.owner,
      args.nonce,
      args.ownerSig,
    );
    return { txHash: tx.hash as string };
  }

  /** Lazy confirmation read for a sent tx (kill.status's revoked flag). */
  async txStatus(txHash: string): Promise<"pending" | "confirmed" | "failed"> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (receipt === null) return "pending";
    return receipt.status === 1 ? "confirmed" : "failed";
  }

  private assertSigner(
    digest: string,
    signature: string,
    owner: string,
    op: string,
  ): void {
    const signer = recoverDigestSigner(digest, signature);
    if (signer.toLowerCase() !== owner.toLowerCase()) {
      // Off-chain guard: never submit (and pay for) a call whose owner
      // signature doesn't verify — the on-chain check is the backstop.
      throw new Error(
        `[relay] ${op} signature does not recover to the owner — not submitting`,
      );
    }
  }

  /** Read the new plan id off the PlanCreated log (topic[1]). */
  private extractPlanId(receipt: TransactionReceipt): bigint {
    for (const log of receipt.logs) {
      try {
        const parsed = this.reader.interface.parseLog(log);
        if (parsed?.name === "PlanCreated") return parsed.args.id as bigint;
      } catch {
        // not our event
      }
    }
    throw new Error("[relay] createPlan succeeded but emitted no PlanCreated");
  }
}
