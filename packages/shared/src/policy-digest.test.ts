import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet, getBytes, verifyMessage } from "ethers";
import { describe, expect, it } from "vitest";
import {
  createPlanDigest,
  enrollEstateDigest,
  revokeAllDigest,
  revokePlanDigest,
  signPolicyDigest,
  type PolicyDomain,
} from "./policy-digest";

/**
 * Cross-impl drift guard (doc 07): the committed fixture vectors — which
 * CrossImpl.t.sol proves the CONTRACT against — must equal what these builders
 * produce today. If either implementation changes, one of the two suites goes
 * red before the drift can ship.
 */
const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../contracts/test/fixtures/policy-vectors.json",
);
const vectors = JSON.parse(readFileSync(fixturePath, "utf8"));
const domain: PolicyDomain = { chainId: vectors.domain.chainId, contract: vectors.domain.contract };

describe("policy-digest ↔ committed fixture vectors", () => {
  it("createPlan digest matches", () => {
    expect(
      createPlanDigest(domain, {
        agent: vectors.createPlan.agent,
        capPerExec: BigInt(vectors.createPlan.capPerExec),
        capPerPeriod: BigInt(vectors.createPlan.capPerPeriod),
        periodSecs: vectors.createPlan.periodSecs,
        assetListHash: vectors.createPlan.assetListHash,
        nonce: BigInt(vectors.createPlan.nonce),
      }),
    ).toBe(vectors.createPlan.digest);
  });

  it("revokePlan digest matches", () => {
    expect(
      revokePlanDigest(domain, {
        id: BigInt(vectors.revokePlan.id),
        nonce: BigInt(vectors.revokePlan.nonce),
      }),
    ).toBe(vectors.revokePlan.digest);
  });

  it("revokeAll digest matches", () => {
    expect(revokeAllDigest(domain, { nonce: BigInt(vectors.revokeAll.nonce) })).toBe(
      vectors.revokeAll.digest,
    );
  });

  it("enrollEstate digest matches", () => {
    expect(
      enrollEstateDigest(domain, {
        beneficiaryHash: vectors.enrollEstate.beneficiaryHash,
        inactivitySecs: BigInt(vectors.enrollEstate.inactivitySecs),
        nonce: BigInt(vectors.enrollEstate.nonce),
      }),
    ).toBe(vectors.enrollEstate.digest);
  });

  it("committed signatures are EIP-191 personal_sign over the digest bytes and recover the fixture signer", () => {
    for (const op of ["createPlan", "revokePlan", "revokeAll", "enrollEstate"] as const) {
      const { digest, sig } = vectors[op];
      expect(verifyMessage(getBytes(digest), sig)).toBe(vectors.signer);
    }
  });

  it("signPolicyDigest reproduces the committed createPlan signature (deterministic ECDSA)", async () => {
    // anvil/foundry's universally-known test key #0 — deterministic, holds nothing
    const wallet = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    expect(wallet.address).toBe(vectors.signer);
    await expect(signPolicyDigest(wallet, vectors.createPlan.digest)).resolves.toBe(
      vectors.createPlan.sig,
    );
  });

  it("digests are domain-separated (chain id and contract address both matter)", () => {
    const p = { id: 0n, nonce: 1n };
    const other = revokePlanDigest({ ...domain, chainId: 42161 }, p);
    expect(other).not.toBe(vectors.revokePlan.digest);
    const otherContract = revokePlanDigest(
      { ...domain, contract: "0x1000000000000000000000000000000000000008" },
      p,
    );
    expect(otherContract).not.toBe(vectors.revokePlan.digest);
  });
});
