// packages/ua/src/signers.ts — the two 7702 signing flows behind one interface.
//
// This package holds NO keys. Every signer is INJECTED: a Magic session (browser),
// a raw dev Wallet (backend smoke), or KMS (doc 08, apps/worker — same interface).
import { getBytes, hashAuthorization, Signature } from "ethers";

/**
 * The signing surface signAndSend drives. Two operations, because a 7702 UA
 * transaction needs two kinds of signature:
 *   - the root hash (once per transaction), and
 *   - one authorization tuple per not-yet-delegated (chain, EOA) pair.
 *
 * kmsSigner (doc 08) implements this same interface so browser and backend cannot
 * drift.
 */
export interface UaSigner {
  /** Sign tx.rootHash. Plain personal_sign (browser) / signMessageSync(getBytes(...))
   *  (backend) — the EIP-191 personal-message digest, NOT typed data and NOT raw
   *  ECDSA over the hex string (G5). */
  signRootHash(rootHash: string): Promise<string>;
  /** Sign one EIP-7702 authorization tuple → serialized 65-byte hex. */
  sign7702Auth(a: {
    chainId: number;
    nonce: number;
    address: string;
  }): Promise<string>;
}

// ---------------------------------------------------------------------------
// magicSigner — browser flow (doc 02's live Magic surface).
// ---------------------------------------------------------------------------

/** Raw {v,r,s} auth from magic.wallet.sign7702Authorization. */
interface Magic7702Raw {
  v: number | string | bigint;
  r: string;
  s: string;
}

/**
 * The structural subset of the Magic client magicSigner touches. Declared here — not
 * imported from magic-sdk — so @retenix/ua never depends on Magic; the worker, which
 * has no Magic client, can still import this package. The real
 * `InstanceWithExtensions<SDKBase, EVMExtension[]>` satisfies it by shape.
 */
export interface MagicSignerClient {
  evm: { switchChain(chainId: number): Promise<unknown> };
  wallet: {
    sign7702Authorization(a: {
      contractAddress: string;
      chainId: number;
      nonce?: number;
    }): Promise<Magic7702Raw>;
  };
  rpcProvider: {
    request(args: { method: string; params: unknown[] }): Promise<string>;
  };
}

export function magicSigner(magic: MagicSignerClient, eoa: string): UaSigner {
  return {
    signRootHash(rootHash) {
      // Headless plain personal_sign (G5). Param order is [message, address], exact.
      return magic.rpcProvider.request({
        method: "personal_sign",
        params: [rootHash, eoa],
      });
    },
    async sign7702Auth({ chainId, nonce, address }) {
      // switchChain MUST precede sign7702Authorization for this chain — it selects
      // the endpoint and (when nonce is omitted) reads the account nonce. The order
      // is load-bearing (doc 02/03); this signer neither hides nor reorders it.
      await magic.evm.switchChain(chainId);
      const raw = await magic.wallet.sign7702Authorization({
        contractAddress: address,
        chainId,
        nonce,
      });
      // {v,r,s} → serialized hex. Construct the SignatureLike explicitly: Magic's
      // full response object does not typecheck as SignatureLike (HANDOFF doc 02 (d)).
      return Signature.from({ r: raw.r, s: raw.s, v: raw.v }).serialized;
    },
  };
}

// ---------------------------------------------------------------------------
// walletSigner — backend dev flow (ethers v6 Wallet). KMS substitutes in prod
// via the same interface, producing the same two digest signatures.
// ---------------------------------------------------------------------------

/** Structural subset of an ethers v6 Wallet walletSigner uses — a real Wallet
 *  satisfies it, and tests can pass a fake. */
export interface WalletSignerClient {
  signMessageSync(message: string | Uint8Array): string;
  signingKey: { sign(digest: string | Uint8Array): { serialized: string } };
}

export function walletSigner(wallet: WalletSignerClient): UaSigner {
  return {
    signRootHash(rootHash) {
      // EIP-191 personal-message digest over the raw rootHash bytes (G5).
      return Promise.resolve(wallet.signMessageSync(getBytes(rootHash)));
    },
    sign7702Auth(auth) {
      // hashAuthorization digest over the (chainId, address, nonce) tuple, signed raw.
      return Promise.resolve(
        wallet.signingKey.sign(hashAuthorization(auth)).serialized,
      );
    },
  };
}
