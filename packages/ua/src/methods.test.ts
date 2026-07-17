import { describe, expect, it, vi } from "vitest";
import type { UniversalAccount } from "@particle-network/universal-account-sdk";
import { SUPPORTED_TOKEN_TYPE } from "./constants";
import {
  createConvertTransaction,
  createSellTransaction,
  parseEIP7702AuthTargets,
  parseEIP7702Deployments,
} from "./methods";

describe("createSellTransaction passthrough", () => {
  it("forwards the optional tradeConfig (doc 06 forces USDC settlement with it)", async () => {
    const sell = vi.fn().mockResolvedValue({ transactionId: "t1" });
    const ua = { createSellTransaction: sell } as unknown as UniversalAccount;
    const payload = { token: { chainId: 8453, address: "0xabc" }, amount: "1.5" };
    const tradeConfig = { usePrimaryTokens: [SUPPORTED_TOKEN_TYPE.USDC] };

    await createSellTransaction(ua, payload, tradeConfig);
    expect(sell).toHaveBeenCalledWith(payload, tradeConfig);

    // Omitted config still forwards undefined — SDK default (all five primaries).
    await createSellTransaction(ua, payload);
    expect(sell).toHaveBeenLastCalledWith(payload, undefined);
  });
});

describe("createConvertTransaction passthrough", () => {
  it("forwards the optional tradeConfig (doc 13 pins each convert to one funding primary)", async () => {
    const convert = vi.fn().mockResolvedValue({ transactionId: "t2" });
    const ua = { createConvertTransaction: convert } as unknown as UniversalAccount;
    const payload = {
      chainId: 42161,
      expectToken: { type: SUPPORTED_TOKEN_TYPE.USDC, amount: "9.80" },
    };
    const tradeConfig = { usePrimaryTokens: [SUPPORTED_TOKEN_TYPE.ETH] };

    await createConvertTransaction(ua, payload, tradeConfig);
    expect(convert).toHaveBeenCalledWith(payload, tradeConfig);

    // Existing callers (no config) are unaffected.
    await createConvertTransaction(ua, payload);
    expect(convert).toHaveBeenLastCalledWith(payload, undefined);
  });
});

describe("parseEIP7702Deployments (OQ5 provisional freeze — doc 15)", () => {
  it("accepts the Particle-demo shape and strips unknown fields", () => {
    const raw = [
      { chainId: 42161, isDelegated: true, extra: "passthrough-ignored" },
      { chainId: 1, isDelegated: false },
    ];
    expect(parseEIP7702Deployments(raw)).toEqual([
      { chainId: 42161, isDelegated: true },
      { chainId: 1, isDelegated: false },
    ]);
  });

  it("empty array is a valid answer (fresh account, nothing delegated)", () => {
    expect(parseEIP7702Deployments([])).toEqual([]);
  });

  it("ANY shape mismatch → null (the honest 'couldn't check' path, never a fake ✓)", () => {
    expect(parseEIP7702Deployments(null)).toBeNull();
    expect(parseEIP7702Deployments(undefined)).toBeNull();
    expect(parseEIP7702Deployments({ deployments: [] })).toBeNull();
    expect(parseEIP7702Deployments([{ chainId: "42161", isDelegated: true }])).toBeNull();
    expect(parseEIP7702Deployments([{ chainId: 42161, isDelegated: "yes" }])).toBeNull();
    expect(parseEIP7702Deployments([{ chainId: 42161 }])).toBeNull();
    expect(parseEIP7702Deployments([null])).toBeNull();
    // one bad row poisons the whole parse — a partial ✓ list would lie by omission
    expect(
      parseEIP7702Deployments([{ chainId: 1, isDelegated: true }, { chainId: 56 }]),
    ).toBeNull();
  });
});

describe("parseEIP7702AuthTargets (OQ5 provisional freeze)", () => {
  it("accepts the demo shape {address, nonce} with optional chainId", () => {
    expect(
      parseEIP7702AuthTargets([
        { address: "0xUA", nonce: 0, chainId: 42161 },
        { address: "0xUA", nonce: 3 },
      ]),
    ).toEqual([
      { address: "0xUA", nonce: 0, chainId: 42161 },
      { address: "0xUA", nonce: 3 },
    ]);
  });

  it("mismatch → null", () => {
    expect(parseEIP7702AuthTargets("nope")).toBeNull();
    expect(parseEIP7702AuthTargets([{ address: 7, nonce: 0 }])).toBeNull();
    expect(parseEIP7702AuthTargets([{ address: "0xUA", nonce: "0" }])).toBeNull();
  });
});
