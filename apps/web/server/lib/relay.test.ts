import {
  createPlanDigest,
  revokePlanDigest,
  signPolicyDigest,
  type PolicyDomain,
} from "@retenix/shared";
import { Wallet, getBytes, hashMessage, recoverAddress } from "ethers";
import { describe, expect, it } from "vitest";
import { recoverDigestSigner } from "./relay";

// The relay recovers an owner from a personal_sign'd policy digest exactly the
// way RetenixPolicy._recover does on-chain (module 07 CrossImpl proves the
// digest bytes; this proves the WEB recovery matches the same signing path
// the contract verifies — a mismatch would make every relayed call revert
// BadSignature).
const DOMAIN: PolicyDomain = {
  chainId: 421614,
  contract: "0x4549a91b4727537372925C8C589d9BCfF9B6c261",
};

describe("recoverDigestSigner (relay ⟷ contract auth parity)", () => {
  it("recovers the createPlan signer from a personal_sign over the digest", async () => {
    const owner = Wallet.createRandom();
    const digest = createPlanDigest(DOMAIN, {
      agent: "0x562937835cdD5C92F54B94Df658Fd3b50A68ecD5",
      capPerExec: 15_000_000n,
      capPerPeriod: 25_000_000n,
      periodSecs: 604_800,
      assetListHash:
        "0x" + "ab".repeat(32),
      nonce: 0n,
    });
    const sig = await signPolicyDigest(owner, digest);
    expect(recoverDigestSigner(digest, sig).toLowerCase()).toBe(
      owner.address.toLowerCase(),
    );
  });

  it("recovers the revokePlan signer", async () => {
    const owner = Wallet.createRandom();
    const digest = revokePlanDigest(DOMAIN, { id: 3n, nonce: 7n });
    const sig = await signPolicyDigest(owner, digest);
    expect(recoverDigestSigner(digest, sig).toLowerCase()).toBe(
      owner.address.toLowerCase(),
    );
  });

  it("matches the contract's prefix scheme (personal_sign over 32 digest bytes)", async () => {
    // The contract does ecrecover(keccak("\x19Ethereum Signed Message:\n32" ++
    // digest)). ethers hashMessage(getBytes(digest)) computes exactly that
    // preimage — assert our recovery equals a hand-rolled one.
    const owner = Wallet.createRandom();
    const digest = revokePlanDigest(DOMAIN, { id: 1n, nonce: 0n });
    const sig = await signPolicyDigest(owner, digest);
    const handRolled = recoverAddress(hashMessage(getBytes(digest)), sig);
    expect(recoverDigestSigner(digest, sig)).toBe(handRolled);
  });

  it("does not recover a foreign signer (tamper guard)", async () => {
    const owner = Wallet.createRandom();
    const other = Wallet.createRandom();
    const digest = revokePlanDigest(DOMAIN, { id: 1n, nonce: 0n });
    const sig = await signPolicyDigest(other, digest);
    expect(recoverDigestSigner(digest, sig).toLowerCase()).not.toBe(
      owner.address.toLowerCase(),
    );
  });
});
