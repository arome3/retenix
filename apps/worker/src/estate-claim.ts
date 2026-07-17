// The per-chain claim sequence (doc 14, tech spec §10 — decided): apply the
// escrowed tuple as a Type-4 transaction → registerHeir → claim(owner,
// tokens[]). Continue-and-report across the 5 chains; every step is
// read-check-then-act so a crashed keeper re-runs the whole sequence safely.
//
// The traps this module exists to survive (proven by rehearse-g4):
// - a stale tuple's Type-4 tx SUCCEEDS while silently skipping the tuple —
//   receipt status proves nothing; getCode(owner) after every apply is the
//   only truth;
// - a REVERTED apply still applies the delegation (7702 processes the
//   authorization list before execution) — resume completes with a plain
//   Type-2 registerHeir, never by re-burning a tuple;
// - `type: 4` must be EXPLICIT — ethers' populateTransaction silently picks
//   type 2 when fee fields are present;
// - tuple hygiene: chainId and delegate address are validated against the
//   chain being claimed before anything is sent (a 0-chainId authorization
//   would replay everywhere).
import { NETWORK_NAMES, type ClaimChainProgress, type EscrowTuple } from "@retenix/shared";
import { Contract, Interface, JsonRpcProvider, NonceManager, Signature, type Signer } from "ethers";

import { chainRpcUrl, claimDelegateFor } from "./estate-support";
import type { ChainScan } from "./estate-scan";

const CLAIM_ABI = [
  "function registerHeir(address owner, address heir)",
  "function claim(address owner, address[] tokens)",
  "function heirOf(address owner) view returns (address)",
  "event HeirRegistered(address indexed owner, address indexed heir)",
  "event AssetClaimed(address indexed owner, address indexed heir, address indexed token, uint256 amount)",
];
const claimIface = new Interface(CLAIM_ABI);
const ZERO = "0x0000000000000000000000000000000000000000";

function delegatedCode(delegate: string): string {
  return `0xef0100${delegate.slice(2).toLowerCase()}`;
}

/** Chain I/O for one chain's claim — injectable (tests run hermetic). */
export interface ClaimChainIo {
  getCode(owner: string): Promise<string>;
  getTransactionCount(owner: string): Promise<number>;
  heirOf(owner: string): Promise<string>;
  /** Type-4: apply the tuple AND call registerHeir in one tx. Returns the
   *  receipt status (a reverted inner call still applies the delegation). */
  sendApplyAndRegister(
    owner: string,
    heir: string,
    tuple: EscrowTuple,
  ): Promise<{ txHash: string; status: number }>;
  /** Plain Type-2 registerHeir (the resume path). */
  sendRegister(owner: string, heir: string): Promise<{ txHash: string; status: number }>;
  /** claim(owner, tokens) — returns decoded AssetClaimed transfers. */
  sendClaim(
    owner: string,
    tokens: string[],
  ): Promise<{ txHash: string; claimed: { token: string; amount: bigint }[] }>;
}

export function makeClaimChainIo(chainId: number, keeperSigner: Signer): ClaimChainIo {
  const provider = new JsonRpcProvider(chainRpcUrl(chainId));
  const signer = new NonceManager(keeperSigner.connect(provider));

  async function gasLimitFor(tx: {
    to: string;
    data: string;
    authorizationList?: unknown[];
  }): Promise<bigint> {
    try {
      const est = await provider.estimateGas(tx as never);
      return est > 128_000n ? (est * 125n) / 100n : 160_000n;
    } catch {
      // some RPC frontends reject authorizationList in eth_estimateGas —
      // and estimating against a not-yet-delegated EOA under-counts anyway
      return 300_000n;
    }
  }

  async function send(tx: object): Promise<{ txHash: string; status: number }> {
    const resp = await signer.sendTransaction(tx as never);
    const receipt = await provider.waitForTransaction(resp.hash);
    return { txHash: resp.hash, status: receipt?.status ?? 0 };
  }

  return {
    getCode: (owner) => provider.getCode(owner),
    getTransactionCount: (owner) => provider.getTransactionCount(owner),
    async heirOf(owner) {
      const atOwner = new Contract(owner, CLAIM_ABI, provider);
      return (await atOwner.heirOf(owner)) as string;
    },
    async sendApplyAndRegister(owner, heir, tuple) {
      const data = claimIface.encodeFunctionData("registerHeir", [owner, heir]);
      const auth = {
        address: tuple.address,
        nonce: BigInt(tuple.nonce),
        chainId: BigInt(tuple.chainId),
        signature: Signature.from({ r: tuple.r, s: tuple.s, yParity: tuple.yParity }),
      };
      const base = { to: owner, data, authorizationList: [auth] };
      return send({
        type: 4, // EXPLICIT — see the header
        ...base,
        gasLimit: await gasLimitFor(base),
      });
    },
    async sendRegister(owner, heir) {
      const data = claimIface.encodeFunctionData("registerHeir", [owner, heir]);
      return send({ to: owner, data, gasLimit: await gasLimitFor({ to: owner, data }) });
    },
    async sendClaim(owner, tokens) {
      const data = claimIface.encodeFunctionData("claim", [owner, tokens]);
      const resp = await signer.sendTransaction({
        to: owner,
        data,
        gasLimit: await gasLimitFor({ to: owner, data }),
      } as never);
      const receipt = await provider.waitForTransaction(resp.hash);
      if (!receipt || receipt.status !== 1) {
        throw new Error(`claim tx ${resp.hash} reverted`);
      }
      const claimed: { token: string; amount: bigint }[] = [];
      for (const log of receipt.logs) {
        try {
          const parsed = claimIface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === "AssetClaimed") {
            claimed.push({
              token: parsed.args.token as string,
              amount: parsed.args.amount as bigint,
            });
          }
        } catch {
          // token Transfer logs etc. — not ours
        }
      }
      return { txHash: resp.hash, claimed };
    },
  };
}

/**
 * One chain's sequence. Returns the terminal progress state for the chain —
 * the caller records it as an estate.claim_progress event and CONTINUES with
 * the other chains regardless (doc 14 failure mode: a stale chain's assets
 * go to the fallback support process; the rest proceed).
 */
export async function claimOnChain(args: {
  io: ClaimChainIo;
  chainId: number;
  owner: string;
  heir: string;
  tuple: EscrowTuple | null;
  /** Fresh scan for the chain (tokens to sweep); null = scan failed. */
  scan: ChainScan | null;
}): Promise<ClaimChainProgress> {
  const { io, chainId, owner, heir } = args;
  const network = NETWORK_NAMES[chainId] ?? `Source ${chainId}`;
  const done = (state: ClaimChainProgress["state"], detail?: string, extra?: Partial<ClaimChainProgress>): ClaimChainProgress => ({
    chainId,
    network,
    state,
    ...(detail ? { detail } : {}),
    ...extra,
  });

  let delegate: string;
  try {
    delegate = claimDelegateFor(chainId);
  } catch {
    return done("skipped", "no delegate recorded for this network");
  }
  if (delegate === ZERO) {
    return done("skipped", "delegate not deployed on this network yet");
  }

  try {
    // --- step A: delegation (idempotent via the getCode probe) ---
    const expected = delegatedCode(delegate);
    let code = (await io.getCode(owner)).toLowerCase();
    if (code !== expected) {
      if (code !== "0x" && code !== "") {
        // some OTHER delegation is live — the owner is active (UA mode) or
        // something unexpected holds the slot; never overwrite it
        return done("failed", "the account has a live delegation that isn't the claim delegate");
      }
      const tuple = args.tuple;
      if (!tuple) return done("stale-tuple", "no escrowed authorization for this network");
      if (tuple.chainId !== chainId) {
        return done("failed", "escrowed authorization is for a different network");
      }
      if (tuple.address.toLowerCase() !== delegate.toLowerCase()) {
        return done("failed", "escrowed authorization targets an unrecognized delegate");
      }
      const liveNonce = await io.getTransactionCount(owner);
      if (tuple.nonce !== liveNonce) {
        // the dead-man switch: owner activity revoked the escrow
        return done(
          "stale-tuple",
          `authorization was signed at nonce ${tuple.nonce}, account is at ${liveNonce}`,
        );
      }
      const applied = await io.sendApplyAndRegister(owner, heir, tuple);
      code = (await io.getCode(owner)).toLowerCase();
      if (code !== expected) {
        // status 1 + no code = the silently-skipped-tuple trap (raced nonce)
        return done("stale-tuple", `delegation not applied (tx ${applied.txHash})`, {
          txHash: applied.txHash,
        });
      }
      // a reverted inner call still applied the delegation — step B repairs it
    }

    // --- step B: registerHeir (one-shot; resume-safe) ---
    let onchainHeir = (await io.heirOf(owner)).toLowerCase();
    if (onchainHeir === ZERO) {
      const reg = await io.sendRegister(owner, heir);
      onchainHeir = (await io.heirOf(owner)).toLowerCase();
      if (onchainHeir === ZERO) {
        return done("failed", `heir registration did not land (tx ${reg.txHash})`, {
          txHash: reg.txHash,
        });
      }
    }
    if (onchainHeir !== heir.toLowerCase()) {
      // one-shot registration holds a DIFFERENT heir — hard stop, support case
      return done("failed", "a different heir is already registered on this network");
    }

    // --- step C: claim (re-runnable; zero balances no-op) ---
    const tokens = args.scan?.tokens ?? [];
    try {
      const res = await io.sendClaim(owner, tokens);
      return done("claimed", undefined, {
        txHash: res.txHash,
        assets: res.claimed.map((c) => ({
          token: c.token === ZERO ? "native" : c.token,
          amountHuman: c.amount.toString(),
        })),
      });
    } catch {
      // a poison token (paused/blocklisted) reverts the batch — isolate it
      const swept: { token: string; amount: bigint }[] = [];
      const failedTokens: string[] = [];
      for (const token of tokens) {
        try {
          const res = await io.sendClaim(owner, [token]);
          swept.push(...res.claimed);
        } catch {
          failedTokens.push(token);
        }
      }
      try {
        const nat = await io.sendClaim(owner, []); // native sweep alone
        swept.push(...nat.claimed);
      } catch {
        // native sweep failed too — reported below
      }
      if (swept.length === 0) {
        return done("failed", "no assets could be moved on this network");
      }
      return done("claimed", failedTokens.length > 0 ? `${failedTokens.length} asset(s) need support follow-up` : undefined, {
        assets: swept.map((c) => ({
          token: c.token === ZERO ? "native" : c.token,
          amountHuman: c.amount.toString(),
        })),
      });
    }
  } catch (err) {
    return done("failed", err instanceof Error ? err.message.slice(0, 200) : "unknown failure");
  }
}
