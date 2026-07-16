// RetenixPolicy client — the worker's ONLY onchain call surface (doc 08).
// recordExecution/refundExecution amounts are usd6-encoded HERE and nowhere
// else (CONFLICTS #11: a 2-dp/6-dp mismatch would silently scale caps ×10⁴).
//
// Write-ahead protocol (crash safety): every state-changing tx is signed
// FIRST (nonce + raw bytes + hash = the "intent"), persisted by the caller
// into executions.quote_json, and only then broadcast. A resumed worker
// classifies a persisted intent instead of re-firing it:
//   receipt found            → included / reverted (decode at that block)
//   nonce consumed, no hash  → dead forever (same-nonce exclusivity) → safe to re-send
//   nonce still free         → rebroadcast the SAME raw bytes
// KMS ECDSA is nondeterministic — re-signing would change the hash, which is
// exactly why the raw bytes are part of the intent.

import {
  Contract,
  Interface,
  JsonRpcProvider,
  keccak256,
  type Signer,
  type TransactionReceipt,
} from "ethers";
import PQueue from "p-queue";
import {
  RETENIX_POLICY_ABI,
  toUsd6,
  type BlockReason,
} from "@retenix/shared";

export const PLAN_STATUS = { Active: 0, Paused: 1, Revoked: 2 } as const;

export interface OnchainPlan {
  owner: string;
  agent: string;
  capPerExec: bigint; // usd6
  capPerPeriod: bigint; // usd6
  periodSecs: number;
  spentInPeriod: bigint; // usd6
  periodStart: number;
  assetListHash: string;
  status: number; // PLAN_STATUS
}

/** A signed-but-maybe-not-landed policy tx, persisted BEFORE broadcast. */
export interface TxIntent {
  kind: "record" | "refund";
  nonce: number;
  txHash: string;
  raw: string;
  chainId: number;
}

export type IntentState =
  | { state: "included"; receipt: TransactionReceipt }
  | { state: "reverted"; reason: BlockReason }
  | { state: "dead" } // nonce consumed by another tx — this intent can never land
  | { state: "pending" }; // not yet mined; raw rebroadcast attempted

const POLICY_ERROR_NAMES: readonly BlockReason[] = [
  "NotActive",
  "NotAgent",
  "OverExecCap",
  "OverPeriodCap",
  "AssetNotAllowed",
];

export const policyInterface = new Interface(RETENIX_POLICY_ABI);

/** Map an ethers revert (or raw revert data) to the receipt-copy reason. */
export function decodePolicyError(err: unknown): BlockReason {
  const data = extractRevertData(err);
  if (data) {
    try {
      const parsed = policyInterface.parseError(data);
      if (parsed && (POLICY_ERROR_NAMES as readonly string[]).includes(parsed.name)) {
        return parsed.name as BlockReason;
      }
    } catch {
      /* fall through to Unknown */
    }
  }
  return "Unknown";
}

function extractRevertData(err: unknown): string | undefined {
  let node: unknown = err;
  for (let depth = 0; depth < 5 && node && typeof node === "object"; depth += 1) {
    const rec = node as Record<string, unknown>;
    const data = rec.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      return data;
    }
    node =
      rec.info && typeof rec.info === "object"
        ? (rec.info as Record<string, unknown>).error ?? rec.error ?? rec.cause
        : rec.error ?? rec.cause;
  }
  return undefined;
}

/** name → 4-byte selector map (tests pin these against doc 07's records). */
export function policyErrorSelectors(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of POLICY_ERROR_NAMES) {
    const frag = policyInterface.getError(name);
    if (frag) out[name] = frag.selector;
  }
  return out;
}

export class PolicyClient {
  readonly provider: JsonRpcProvider;
  readonly address: string;
  private readonly contract: Contract;
  private readonly signer: Signer;
  private agentAddr?: string;
  /** Serializes agent-EOA nonce allocation within this process. */
  private readonly txQueue = new PQueue({ concurrency: 1 });

  constructor(opts: { rpcUrl: string; address: string; signer: Signer }) {
    this.provider = new JsonRpcProvider(opts.rpcUrl);
    this.address = opts.address;
    this.signer = opts.signer.connect(this.provider);
    this.contract = new Contract(opts.address, RETENIX_POLICY_ABI, this.provider);
  }

  async agentAddress(): Promise<string> {
    if (!this.agentAddr) this.agentAddr = await this.signer.getAddress();
    return this.agentAddr;
  }

  /** The contract's immutable agent — boot asserts it equals our signer. */
  async contractAgent(): Promise<string> {
    return (await this.contract.agent()) as string;
  }

  async readPlan(planId: bigint | number): Promise<OnchainPlan> {
    const p = (await this.contract.plans(planId)) as unknown[];
    return {
      owner: p[0] as string,
      agent: p[1] as string,
      capPerExec: p[2] as bigint,
      capPerPeriod: p[3] as bigint,
      periodSecs: Number(p[4]),
      spentInPeriod: p[5] as bigint,
      periodStart: Number(p[6]),
      assetListHash: p[7] as string,
      status: Number(p[8]),
    };
  }

  /**
   * Step-4 fast gate: eth_call the exact recordExecution AS the agent.
   * An expected revert surfaces here in one RPC round-trip — the blocked
   * receipt lands "within seconds" and nothing is broadcast (nothing
   * recorded ⇒ nothing to refund, by construction).
   */
  async staticRecord(
    planId: bigint | number,
    usd: number,
    assetIdHash: string,
  ): Promise<{ ok: true } | { ok: false; reason: BlockReason }> {
    try {
      await this.contract.recordExecution.staticCall(planId, toUsd6(usd), assetIdHash, {
        from: await this.agentAddress(),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: decodePolicyError(err) };
    }
  }

  /** Sign (never broadcast) recordExecution — THE usd6 encode site. */
  prepareRecord(planId: bigint | number, usd: number, assetIdHash: string): Promise<TxIntent> {
    return this.prepare("record", "recordExecution", [planId, toUsd6(usd), assetIdHash]);
  }

  /** Sign (never broadcast) refundExecution — the other usd6 encode site. */
  prepareRefund(planId: bigint | number, usd: number): Promise<TxIntent> {
    return this.prepare("refund", "refundExecution", [planId, toUsd6(usd)]);
  }

  private prepare(
    kind: TxIntent["kind"],
    fn: "recordExecution" | "refundExecution",
    args: unknown[],
  ): Promise<TxIntent> {
    return this.txQueue.add(async (): Promise<TxIntent> => {
        const from = await this.agentAddress();
        const data = policyInterface.encodeFunctionData(fn, args);
        const [nonce, fee, network, gas] = await Promise.all([
          this.provider.getTransactionCount(from, "pending"),
          this.provider.getFeeData(),
          this.provider.getNetwork(),
          this.provider.estimateGas({ from, to: this.address, data }),
        ]);
        const raw = await this.signer.signTransaction({
          type: 2,
          chainId: network.chainId,
          nonce,
          to: this.address,
          data,
          gasLimit: (gas * 12n) / 10n,
          maxFeePerGas: fee.maxFeePerGas ?? 100_000_000n,
          maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n,
        });
        return { kind, nonce, txHash: keccak256(raw), raw, chainId: Number(network.chainId) };
    });
  }

  /** Broadcast a persisted intent and wait one confirmation. */
  async submitIntent(
    intent: TxIntent,
    { timeoutMs = 120_000 }: { timeoutMs?: number } = {},
  ): Promise<IntentState> {
    try {
      await this.provider.broadcastTransaction(intent.raw);
    } catch {
      // "already known" / "nonce too low" — classification below decides.
    }
    const receipt = await this.provider
      .waitForTransaction(intent.txHash, 1, timeoutMs)
      .catch(() => null);
    if (receipt) return this.classifyReceipt(intent, receipt);
    return this.reconcileIntent(intent);
  }

  /**
   * Resume-time classification of a persisted intent (never re-fires).
   * "dead" is proven by nonce consumption without our hash — the only state
   * in which re-preparing the same logical call is safe.
   */
  async reconcileIntent(intent: TxIntent): Promise<IntentState> {
    const receipt = await this.provider.getTransactionReceipt(intent.txHash);
    if (receipt) return this.classifyReceipt(intent, receipt);
    const confirmedNonce = await this.provider.getTransactionCount(
      await this.agentAddress(),
      "latest",
    );
    if (confirmedNonce > intent.nonce) {
      // The slot is spent. Re-check the hash once — it may have landed
      // between the two RPCs — then declare the intent dead forever.
      const again = await this.provider.getTransactionReceipt(intent.txHash);
      if (again) return this.classifyReceipt(intent, again);
      return { state: "dead" };
    }
    try {
      await this.provider.broadcastTransaction(intent.raw);
    } catch {
      // Known / underpriced / racing — the next reconcile pass decides.
    }
    return { state: "pending" };
  }

  private async classifyReceipt(
    intent: TxIntent,
    receipt: TransactionReceipt,
  ): Promise<IntentState> {
    if (receipt.status === 1) return { state: "included", receipt };
    // Reverted at inclusion (e.g. a revoke raced our broadcast): replay the
    // call at that block to decode the custom error for the receipt copy.
    try {
      const tx = await this.provider.getTransaction(intent.txHash);
      if (tx) {
        await this.provider.call({
          from: tx.from,
          to: tx.to,
          data: tx.data,
          blockTag: receipt.blockNumber,
        });
      }
      return { state: "reverted", reason: "Unknown" };
    } catch (err) {
      return { state: "reverted", reason: decodePolicyError(err) };
    }
  }
}
