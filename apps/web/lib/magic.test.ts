import { describe, expect, it } from "vitest";
import {
  ARBITRUM_MAINNET_ONE,
  DEFAULT_EVM_CHAIN_ID,
  DEFAULT_EVM_ENDPOINT,
  DEFAULT_MAGIC_NETWORK,
  EVM_ENDPOINTS,
} from "./evm-endpoints";
import { getMagic, magic } from "./magic";

describe("EVM endpoint table (doc 02 PROPOSED)", () => {
  it("covers exactly the five EVM ids doc 02 names, and no Solana", () => {
    expect(EVM_ENDPOINTS.map((n) => n.chainId).sort((a, b) => a - b)).toEqual([
      1, 56, 196, 8453, 42161,
    ]);
  });

  it("starts on Arbitrum One — RetenixPolicy's home and the gate-G1 target", () => {
    expect(DEFAULT_EVM_CHAIN_ID).toBe(ARBITRUM_MAINNET_ONE);
    expect(DEFAULT_EVM_ENDPOINT.chainId).toBe(ARBITRUM_MAINNET_ONE);
    expect(EVM_ENDPOINTS.filter((n) => n.default)).toHaveLength(1);
  });

  it("gives every entry an https endpoint", () => {
    for (const n of EVM_ENDPOINTS) {
      expect(n.rpcUrl.startsWith("https://")).toBe(true);
    }
  });

  // Magic's `network` option is CustomNodeConfiguration, which has no `default`
  // key — that one belongs to the extension's array entries. TypeScript will not
  // catch the difference, because excess-property checking skips variables.
  it("hands Magic a network config with no stray keys", () => {
    expect(Object.keys(DEFAULT_MAGIC_NETWORK).sort()).toEqual(["chainId", "rpcUrl"]);
    expect(DEFAULT_MAGIC_NETWORK).not.toHaveProperty("default");
    expect(DEFAULT_MAGIC_NETWORK.chainId).toBe(DEFAULT_EVM_ENDPOINT.chainId);
    expect(DEFAULT_MAGIC_NETWORK.rpcUrl).toBe(DEFAULT_EVM_ENDPOINT.rpcUrl);
  });
});

describe("magic singleton SSR guard", () => {
  it("throws by name on the server rather than reaching for window", () => {
    expect(typeof window).toBe("undefined");
    expect(() => getMagic()).toThrow(/browser-only/);
  });

  it("defers construction until the proxy is touched", () => {
    // Importing the module must not construct anything; only property access does.
    expect(() => magic.user).toThrow(/browser-only/);
  });
});
