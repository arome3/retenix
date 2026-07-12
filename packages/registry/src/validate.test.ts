import { describe, expect, it } from "vitest";
import { REGISTRY, XS_PREFIX, type RegistryAsset } from "./assets";
import { validateRegistry } from "./validate";

// A valid pinned equity to mutate into each failure case.
const goodEquity: RegistryAsset = {
  id: "tslax",
  ticker: "TSLAx",
  name: "Tesla (tokenized)",
  kind: "equity",
  chainId: 101,
  address: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  eligibleRegions: "NON_RESTRICTED",
  disclosure: "TSLAx tracks Tesla stock. It is not a share — no voting rights or dividend claims. Issuer: Backed.",
  issuer: "Backed",
};

describe("validateRegistry (fake-mint guard, G11)", () => {
  it("accepts the real pinned REGISTRY", () => {
    expect(() => validateRegistry(REGISTRY)).not.toThrow();
  });

  it("rejects an equity whose mint lacks the Xs prefix (the tripwire fires)", () => {
    // A real, valid Solana mint (wrapped SOL) — but NOT an xStocks Xs-mint.
    const fake: RegistryAsset = {
      ...goodEquity,
      address: "So11111111111111111111111111111111111111112",
    };
    expect(() => validateRegistry([fake])).toThrow(/FAKE-MINT GUARD/);
  });

  it("rejects a duplicated asset id", () => {
    expect(() => validateRegistry([goodEquity, { ...goodEquity }])).toThrow(
      /duplicate asset ids/,
    );
  });

  it("rejects an equity with a missing disclosure", () => {
    const noDisclosure: RegistryAsset = {
      ...goodEquity,
      id: "aaplx",
      disclosure: undefined,
    };
    expect(() => validateRegistry([noDisclosure])).toThrow(/equity invariants/);
  });

  it("rejects an equity that is not on Solana (101)", () => {
    const wrongChain: RegistryAsset = { ...goodEquity, id: "nvdax", chainId: 1 };
    expect(() => validateRegistry([wrongChain])).toThrow(/Solana SPL mints/);
  });

  it("rejects an equity marked ALL instead of NON_RESTRICTED", () => {
    const wrongGate: RegistryAsset = {
      ...goodEquity,
      id: "spyx",
      eligibleRegions: "ALL",
    };
    expect(() => validateRegistry([wrongGate])).toThrow(/equity invariants/);
  });

  it("does not constrain crypto entries (SOL/ETH need no Xs prefix or disclosure)", () => {
    const sol: RegistryAsset = {
      id: "sol",
      ticker: "SOL",
      name: "Solana",
      kind: "crypto",
      chainId: 101,
      address: "0x0000000000000000000000000000000000000000",
      eligibleRegions: "ALL",
    };
    expect(() => validateRegistry([sol])).not.toThrow();
  });

  it("exports the Xs prefix constant used as the tripwire", () => {
    expect(XS_PREFIX).toBe("Xs");
  });
});
