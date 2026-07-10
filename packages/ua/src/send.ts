// packages/ua/src/send.ts — the ONE signing loop (tech spec §5), so the browser and
// backend flows can never drift.
//
// Security: quotes expire, so a `tx` is created, signed, and sent in one continuous
// flow and NEVER persisted for later signing (this is exactly why estate fallback (a)
// was rejected — tech spec §10). Callers pass a freshly created `tx`.
import type {
  UniversalAccount,
  EIP7702Authorization,
  ITransaction,
  IUserOpWithChain,
} from "@particle-network/universal-account-sdk";
import type { UaSigner } from "./signers";

/** Minimal surface signAndSend needs — the real UniversalAccount satisfies it, and
 *  unit tests inject a mock sendTransaction. */
export type TransactionSender = Pick<UniversalAccount, "sendTransaction">;

/**
 * For every userOp that still needs a 7702 delegation, collect one authorization,
 * sign the root hash, then send. `ua.sendTransaction` matches each
 * `EIP7702Authorization { userOpHash, signature }` back to its userOp by userOpHash.
 */
export async function signAndSend(
  ua: TransactionSender,
  tx: ITransaction,
  signer: UaSigner,
): Promise<{ transactionId: string }> {
  const authorizations = await collectAuthorizations(tx.userOps, signer);
  const rootSig = await signer.signRootHash(tx.rootHash);
  const result = (await ua.sendTransaction(tx, rootSig, authorizations)) as {
    transactionId?: string;
  };
  if (!result?.transactionId) {
    throw new Error("signAndSend: sendTransaction returned no transactionId");
  }
  return { transactionId: result.transactionId };
}

/**
 * The authorization-collection half, factored out so the dedup cache and the
 * already-delegated skip are unit-testable without a live UA.
 *
 * Sign an authorization only when `eip7702Auth` is present AND `eip7702Delegated` is
 * false — the FIRST transaction on a chain carries the tuple; subsequent ones don't
 * (one delegation per EOA per chain; applying it increments the nonce — G6).
 *
 * Cache key = the FULL (chainId, address, nonce) tuple, not the nonce alone. The
 * signature commits to all three (both hashAuthorization and Magic's
 * sign7702Authorization take chainId), and a fresh EOA carries nonce 0 on EVERY
 * chain — so a nonce-only cache (the spec's single-chain reference snippet and
 * Particle's own convert example both use one) would hand chain A's signature to
 * chain B in a multi-source transaction, producing an authorization whose signed
 * chainId is wrong. The full-tuple key preserves the exact dedup intent — "several
 * userOps sharing one chain's delegation share one signature" — while staying
 * collision-safe across chains. (Deliberate, documented deviation — see HANDOFF.)
 */
export async function collectAuthorizations(
  userOps: readonly IUserOpWithChain[],
  signer: UaSigner,
): Promise<EIP7702Authorization[]> {
  const authorizations: EIP7702Authorization[] = [];
  const cache = new Map<string, string>();
  for (const op of userOps) {
    if (op.eip7702Auth && !op.eip7702Delegated) {
      const { chainId, address, nonce } = op.eip7702Auth;
      const key = `${chainId}:${address.toLowerCase()}:${nonce}`;
      let sig = cache.get(key);
      if (!sig) {
        sig = await signer.sign7702Auth(op.eip7702Auth);
        cache.set(key, sig);
      }
      authorizations.push({ userOpHash: op.userOpHash, signature: sig });
    }
  }
  return authorizations;
}
