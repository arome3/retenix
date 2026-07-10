import type {
  ITransaction,
  IUserOpWithChain,
} from "@particle-network/universal-account-sdk";
import { describe, expect, it } from "vitest";
import { collectAuthorizations, signAndSend, type TransactionSender } from "./send";
import type { UaSigner } from "./signers";

/** A signer that records every call and returns deterministic, tuple-encoding sigs. */
function recordingSigner() {
  const authCalls: { chainId: number; nonce: number; address: string }[] = [];
  let rootCalls = 0;
  const signer: UaSigner = {
    signRootHash(hash) {
      rootCalls++;
      return Promise.resolve(`ROOTSIG:${hash}`);
    },
    sign7702Auth(a) {
      authCalls.push(a);
      return Promise.resolve(`SIG:${a.chainId}:${a.nonce}`);
    },
  };
  return {
    signer,
    authCalls,
    rootCalls: () => rootCalls,
  };
}

/** Minimal IUserOpWithChain for the loop (only the fields it reads). */
function op(o: {
  hash: string;
  chainId?: number;
  address?: string;
  nonce?: number;
  delegated?: boolean;
}): IUserOpWithChain {
  const base: Record<string, unknown> = { userOpHash: o.hash };
  if (o.chainId !== undefined) {
    base.eip7702Auth = {
      chainId: o.chainId,
      address: o.address ?? "0xDELEGATE",
      nonce: o.nonce ?? 0,
    };
    base.eip7702Delegated = o.delegated ?? false;
  }
  return base as unknown as IUserOpWithChain;
}

describe("collectAuthorizations", () => {
  it("signs only userOps that need a delegation (eip7702Auth present AND not delegated)", async () => {
    const { signer, authCalls } = recordingSigner();
    const auths = await collectAuthorizations(
      [
        op({ hash: "needs", chainId: 42161, nonce: 0 }),
        op({ hash: "already", chainId: 42161, nonce: 1, delegated: true }),
        op({ hash: "no-auth" }), // no eip7702Auth at all
      ],
      signer,
    );
    expect(auths).toEqual([{ userOpHash: "needs", signature: "SIG:42161:0" }]);
    expect(authCalls).toHaveLength(1);
  });

  it("dedups identical (chainId,address,nonce) tuples — signs once, reuses the sig", async () => {
    const { signer, authCalls } = recordingSigner();
    const auths = await collectAuthorizations(
      [
        op({ hash: "h1", chainId: 42161, address: "0xDEL", nonce: 0 }),
        op({ hash: "h2", chainId: 42161, address: "0xDEL", nonce: 0 }),
      ],
      signer,
    );
    expect(authCalls).toHaveLength(1); // signed ONCE for the shared tuple
    expect(auths).toEqual([
      { userOpHash: "h1", signature: "SIG:42161:0" },
      { userOpHash: "h2", signature: "SIG:42161:0" }, // from cache
    ]);
  });

  it("does NOT collapse across chains that share a nonce (fresh-EOA collision guard)", async () => {
    // A fresh EOA has nonce 0 on every chain. A nonce-only cache would hand chain
    // 42161's signature to chain 8453 — an authorization whose signed chainId is
    // wrong. The full-tuple key keeps them distinct.
    const { signer, authCalls } = recordingSigner();
    const auths = await collectAuthorizations(
      [
        op({ hash: "hA", chainId: 42161, address: "0xDEL", nonce: 0 }),
        op({ hash: "hB", chainId: 8453, address: "0xDEL", nonce: 0 }),
      ],
      signer,
    );
    expect(authCalls).toHaveLength(2); // signed once PER chain
    expect(auths).toEqual([
      { userOpHash: "hA", signature: "SIG:42161:0" },
      { userOpHash: "hB", signature: "SIG:8453:0" },
    ]);
  });

  it("collects nothing when no userOp needs a delegation", async () => {
    const { signer, authCalls } = recordingSigner();
    const auths = await collectAuthorizations(
      [op({ hash: "x", chainId: 1, delegated: true }), op({ hash: "y" })],
      signer,
    );
    expect(auths).toEqual([]);
    expect(authCalls).toHaveLength(0);
  });
});

describe("signAndSend", () => {
  const tx = (userOps: IUserOpWithChain[], rootHash = "0xROOT") =>
    ({ rootHash, userOps }) as unknown as ITransaction;

  it("collects auths, signs the root once, sends, and returns the transactionId", async () => {
    const { signer, rootCalls } = recordingSigner();
    const captured: {
      sig?: string;
      auths?: { userOpHash: string; signature: string }[];
    } = {};
    const ua: TransactionSender = {
      sendTransaction: (_tx, signature, authorizations) => {
        captured.sig = signature;
        captured.auths = authorizations;
        return Promise.resolve({ transactionId: "0xTX" });
      },
    };
    const res = await signAndSend(
      ua,
      tx([op({ hash: "h1", chainId: 1, nonce: 2 })]),
      signer,
    );
    expect(res).toEqual({ transactionId: "0xTX" });
    expect(rootCalls()).toBe(1);
    expect(captured.sig).toBe("ROOTSIG:0xROOT");
    expect(captured.auths).toEqual([
      { userOpHash: "h1", signature: "SIG:1:2" },
    ]);
  });

  it("throws when sendTransaction returns no transactionId", async () => {
    const { signer } = recordingSigner();
    const ua: TransactionSender = {
      sendTransaction: () => Promise.resolve({}),
    };
    await expect(signAndSend(ua, tx([]), signer)).rejects.toThrow(
      /no transactionId/,
    );
  });
});
