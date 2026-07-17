import { describe, expect, it } from "vitest";
import { assetIdHash, assetListHash } from "./hash";

describe("assetIdHash (per-asset bytes32)", () => {
  it("is deterministic for the same id", () => {
    expect(assetIdHash("spyx")).toBe(assetIdHash("spyx"));
  });

  it("is distinct for different ids", () => {
    expect(assetIdHash("spyx")).not.toBe(assetIdHash("tslax"));
  });

  it("returns a 32-byte keccak (0x + 64 hex)", () => {
    expect(assetIdHash("spyx")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("assetListHash (keccak of sorted allowed ids, TS-6.2)", () => {
  it("is order-insensitive: ['a','b'] === ['b','a']", () => {
    expect(assetListHash(["a", "b"])).toBe(assetListHash(["b", "a"]));
  });

  it("is collision-distinct for different sets", () => {
    expect(assetListHash(["a", "b"])).not.toBe(assetListHash(["a", "c"]));
    expect(assetListHash(["a", "b"])).not.toBe(assetListHash(["a", "b", "c"]));
  });

  it("does not mutate the caller's array ([...ids].sort() copies first)", () => {
    const ids = ["b", "a"];
    assetListHash(ids);
    expect(ids).toEqual(["b", "a"]);
  });

  it("the pipe delimiter prevents concatenation collisions: ['ab'] !== ['a','b']", () => {
    expect(assetListHash(["ab"])).not.toBe(assetListHash(["a", "b"]));
  });

  it("a gold-containing basket folds paxg into the allowlist preimage (doc 20)", () => {
    // The Guardian allowlist covers a mixed basket only if gold participates in
    // the hash the owner signs. assetListHash is asset-agnostic, so adding paxg
    // changes the hash (it is part of the set) — never collides with the
    // gold-less basket, and stays order-insensitive.
    const withGold = assetListHash(["spyx", "paxg", "sol"]);
    const withoutGold = assetListHash(["spyx", "sol"]);
    expect(withGold).not.toBe(withoutGold);
    expect(withGold).toBe(assetListHash(["sol", "spyx", "paxg"])); // order-insensitive
    expect(assetIdHash("paxg")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
