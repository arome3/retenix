import { describe, expect, it, vi } from "vitest";
import type { UniversalAccount } from "@particle-network/universal-account-sdk";
import { SUPPORTED_TOKEN_TYPE } from "./constants";
import { createConvertTransaction, createSellTransaction } from "./methods";

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
