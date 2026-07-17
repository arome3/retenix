import { describe, expect, it } from "vitest";

import {
  CHAIN_ID,
  RETENIX_CHAIN_IDS,
  RETENIX_PRIMARY_ASSETS,
  SUPPORTED_TOKEN_TYPE,
  networksForAsset,
  primaryTokenFor,
} from "./constants";

// ---------------------------------------------------------------------------
// networksForAsset — GOLDEN-PINNED against the 2.0.3 SDK's own
// SUPPORTED_PRIMARY_TOKENS (doc 15 withdraw derivation). If an SDK upgrade
// changes where a primary exists, these pins fail and force a product review
// of the withdraw network lists (the registry golden-pin pattern).
// ---------------------------------------------------------------------------

describe("networksForAsset (doc 15 withdraw network derivation)", () => {
  it("usdc — five networks incl. Solana, spec §3 order", () => {
    expect(networksForAsset(SUPPORTED_TOKEN_TYPE.USDC)).toEqual([
      CHAIN_ID.SOLANA_MAINNET, // 101
      CHAIN_ID.ETHEREUM_MAINNET, // 1
      CHAIN_ID.BSC_MAINNET, // 56
      CHAIN_ID.BASE_MAINNET, // 8453
      CHAIN_ID.ARBITRUM_MAINNET_ONE, // 42161
    ]);
  });

  it("usdt — four networks incl. Solana", () => {
    expect(networksForAsset(SUPPORTED_TOKEN_TYPE.USDT)).toEqual([
      CHAIN_ID.SOLANA_MAINNET,
      CHAIN_ID.ETHEREUM_MAINNET,
      CHAIN_ID.BSC_MAINNET,
      CHAIN_ID.ARBITRUM_MAINNET_ONE,
    ]);
  });

  it("eth — four EVM networks, no Solana", () => {
    expect(networksForAsset(SUPPORTED_TOKEN_TYPE.ETH)).toEqual([
      CHAIN_ID.ETHEREUM_MAINNET,
      CHAIN_ID.BSC_MAINNET,
      CHAIN_ID.BASE_MAINNET,
      CHAIN_ID.ARBITRUM_MAINNET_ONE,
    ]);
  });

  it("single-network assets still return a list (the UI must never default-select)", () => {
    expect(networksForAsset(SUPPORTED_TOKEN_TYPE.SOL)).toEqual([CHAIN_ID.SOLANA_MAINNET]);
    expect(networksForAsset(SUPPORTED_TOKEN_TYPE.BNB)).toEqual([CHAIN_ID.BSC_MAINNET]);
  });

  it("X Layer never appears — the SDK has zero chain-196 primaries", () => {
    for (const asset of RETENIX_PRIMARY_ASSETS) {
      expect(networksForAsset(asset)).not.toContain(CHAIN_ID.XLAYER_MAINNET);
    }
  });

  it("every derived chain is one of the six supported networks, in spec order", () => {
    const specOrder = RETENIX_CHAIN_IDS as readonly number[];
    for (const asset of RETENIX_PRIMARY_ASSETS) {
      const list = networksForAsset(asset);
      expect(list.length).toBeGreaterThan(0);
      // subsequence of the spec order → stable UI ordering
      const idx = list.map((id) => specOrder.indexOf(id));
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
      expect(idx).not.toContain(-1);
    }
  });
});

describe("primaryTokenFor", () => {
  it("returns the token record for a valid pair — and pins the decimals trap", () => {
    const usdcArb = primaryTokenFor(
      SUPPORTED_TOKEN_TYPE.USDC,
      CHAIN_ID.ARBITRUM_MAINNET_ONE,
    );
    expect(usdcArb).not.toBeNull();
    expect(usdcArb?.chainId).toBe(42161);
    expect(usdcArb?.type).toBe(SUPPORTED_TOKEN_TYPE.USDC);
    expect(usdcArb?.address).toBe("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
    // TRAP (pinned so no one "fixes" it backwards): `decimals` is the SDK's
    // 18-dp NORMALIZED precision; the on-chain precision is `realDecimals`.
    // Withdraw amount truncation (doc 15) must use realDecimals.
    expect(usdcArb?.decimals).toBe(18);
    expect(usdcArb?.realDecimals).toBe(6);
    const sol = primaryTokenFor(SUPPORTED_TOKEN_TYPE.SOL, CHAIN_ID.SOLANA_MAINNET);
    expect(sol?.realDecimals).toBe(9);
  });

  it("null for a pair where the asset does not exist — the invalid-pair guard", () => {
    expect(primaryTokenFor(SUPPORTED_TOKEN_TYPE.SOL, CHAIN_ID.ARBITRUM_MAINNET_ONE)).toBeNull();
    expect(primaryTokenFor(SUPPORTED_TOKEN_TYPE.USDC, CHAIN_ID.XLAYER_MAINNET)).toBeNull();
    expect(primaryTokenFor(SUPPORTED_TOKEN_TYPE.ETH, CHAIN_ID.SOLANA_MAINNET)).toBeNull();
  });

  it("agrees with networksForAsset for every asset/chain combination", () => {
    for (const asset of RETENIX_PRIMARY_ASSETS) {
      const chains = networksForAsset(asset);
      for (const chainId of RETENIX_CHAIN_IDS as readonly number[]) {
        const token = primaryTokenFor(asset, chainId);
        expect(token !== null).toBe(chains.includes(chainId));
      }
    }
  });
});
