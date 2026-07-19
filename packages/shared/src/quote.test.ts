import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUOTE_FEE_FLOOR_USD,
  quoteFeeFloorUsd,
  QUOTE_FEE_FLOOR_USD_BY_CHAIN,
} from "./quote";

describe("quoteFeeFloorUsd (chain-aware quote-sanity floor, doc 20)", () => {
  it("uses the default floor for Solana (101) and L2s", () => {
    for (const chainId of [101, 8453, 42161, 56, 196]) {
      expect(quoteFeeFloorUsd(chainId)).toBe(DEFAULT_QUOTE_FEE_FLOOR_USD);
    }
    expect(DEFAULT_QUOTE_FEE_FLOOR_USD).toBe(0.5);
  });

  it("raises the floor on Ethereum mainnet (1) — gold legs cost real gas", () => {
    expect(quoteFeeFloorUsd(1)).toBe(3.0);
    expect(quoteFeeFloorUsd(1)).toBeGreaterThan(DEFAULT_QUOTE_FEE_FLOOR_USD);
  });

  it("the override map contains chain 1 (the calibration target for G-R1)", () => {
    expect(QUOTE_FEE_FLOOR_USD_BY_CHAIN[1]).toBeDefined();
  });

  it("an unknown chain falls back to the default", () => {
    expect(quoteFeeFloorUsd(999999)).toBe(DEFAULT_QUOTE_FEE_FLOOR_USD);
  });
});
