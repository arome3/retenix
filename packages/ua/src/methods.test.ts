import { describe, expect, it, vi } from "vitest";
import type { UniversalAccount } from "@particle-network/universal-account-sdk";
import { SUPPORTED_TOKEN_TYPE } from "./constants";
import { createSellTransaction } from "./methods";

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
