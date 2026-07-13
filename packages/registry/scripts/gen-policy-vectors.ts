/**
 * Generates the cross-implementation fixture vectors for RetenixPolicy
 * (doc 07): TS assetIdHash/assetListHash (imported from ../src/hash — the
 * canonical preimage, NEVER reimplemented) and the relayed-auth digests +
 * signatures (from @retenix/shared policy-digest).
 *
 * Output: contracts/test/fixtures/policy-vectors.json — committed; consumed by
 *   - contracts/test/CrossImpl.t.sol  (Solidity == TS, incl. end-to-end sigs)
 *   - packages/shared/src/policy-digest.test.ts (drift guard: regenerate == committed)
 *
 * Run: pnpm --filter @retenix/registry gen:vectors
 *
 * The signing key is anvil/foundry's universally-known test key #0 — it holds
 * nothing and secures nothing; it exists so the vectors are deterministic.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import {
  createPlanDigest,
  enrollEstateDigest,
  revokeAllDigest,
  revokePlanDigest,
  signPolicyDigest,
  toUsd6,
  type PolicyDomain,
} from "@retenix/shared";
import { assetIdHash, assetListHash } from "../src/hash";

const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export async function buildVectors() {
  const wallet = new Wallet(ANVIL_KEY_0);
  const domain: PolicyDomain = {
    chainId: 421614, // Arbitrum Sepolia — the dev target
    contract: "0x1000000000000000000000000000000000000007",
  };
  // The demo-beat-5 plan: $50/exec, $50/period, [spyx, tslax, sol]
  const demoIds = ["spyx", "tslax", "sol"];
  const createPlan = {
    agent: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // anvil #1 — fixture agent
    capPerExec: toUsd6(50),
    capPerPeriod: toUsd6(50),
    periodSecs: 604_800,
    assetListHash: assetListHash(demoIds),
    nonce: 0n,
  };
  const revokePlan = { id: 0n, nonce: 1n };
  const revokeAll = { nonce: 2n };
  const enrollEstate = {
    beneficiaryHash: keccak256(toUtf8Bytes("heir@example.com|fixture-salt")),
    inactivitySecs: 120n,
    nonce: 3n,
  };

  const digests = {
    createPlan: createPlanDigest(domain, createPlan),
    revokePlan: revokePlanDigest(domain, revokePlan),
    revokeAll: revokeAllDigest(domain, revokeAll),
    enrollEstate: enrollEstateDigest(domain, enrollEstate),
  };

  return {
    domain: { chainId: Number(domain.chainId), contract: domain.contract },
    signer: wallet.address,
    assetIdHashes: {
      spyx: assetIdHash("spyx"),
      tslax: assetIdHash("tslax"),
      sol: assetIdHash("sol"),
      // deliberately NOT in the registry — the demo's $500 memecoin attempt
      memecoin: assetIdHash("memecoin"),
    },
    listHashes: {
      // sorted-join preimage cases (the "|" delimiter is load-bearing)
      demo: assetListHash(demoIds),
      demoSortedJoin: [...demoIds].sort().join("|"),
      demoShuffledInput: assetListHash(["tslax", "sol", "spyx"]), // order-insensitive
      single: assetListHash(["spyx"]),
      empty: assetListHash([]),
      ab: assetListHash(["ab"]),
      a_b: assetListHash(["a", "b"]), // must differ from "ab"
    },
    createPlan: {
      agent: createPlan.agent,
      capPerExec: createPlan.capPerExec.toString(),
      capPerPeriod: createPlan.capPerPeriod.toString(),
      periodSecs: createPlan.periodSecs,
      assetListHash: createPlan.assetListHash,
      assetIdsSorted: [...demoIds].sort(),
      nonce: Number(createPlan.nonce),
      digest: digests.createPlan,
      sig: await signPolicyDigest(wallet, digests.createPlan),
    },
    revokePlan: {
      id: Number(revokePlan.id),
      nonce: Number(revokePlan.nonce),
      digest: digests.revokePlan,
      sig: await signPolicyDigest(wallet, digests.revokePlan),
    },
    revokeAll: {
      nonce: Number(revokeAll.nonce),
      digest: digests.revokeAll,
      sig: await signPolicyDigest(wallet, digests.revokeAll),
    },
    enrollEstate: {
      beneficiaryHash: enrollEstate.beneficiaryHash,
      inactivitySecs: Number(enrollEstate.inactivitySecs),
      nonce: Number(enrollEstate.nonce),
      digest: digests.enrollEstate,
      sig: await signPolicyDigest(wallet, digests.enrollEstate),
    },
    // usd6 encode vectors (CONFLICTS #11): asserted in Solidity so a 2-dp/6-dp
    // mismatch (caps silently ×10⁴) can never slip between worker and contract
    usd6: {
      usd15: toUsd6(15).toString(),
      usd45: toUsd6(45).toString(),
      usd50: toUsd6(50).toString(),
      usd500: toUsd6(500).toString(),
      cents1: toUsd6(0.01).toString(),
    },
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../../contracts/test/fixtures/policy-vectors.json");
  buildVectors().then((vectors) => {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
    console.log(`wrote ${out}`);
  });
}
