import { REGISTRY } from "@retenix/registry";
import { DUST_FLOOR_USD, type FeeTotals } from "@retenix/shared";
import { SUPPORTED_PRIMARY_TOKENS } from "@retenix/ua";
import { describe, expect, it } from "vitest";
import {
  RpcMethodUnsupported,
  applyValueRules,
  buildExclusionSet,
  feesExceedValue,
  humanAmount,
  scanDust,
  type DustScanDeps,
} from "./dust";

const EOA = "0xaBcDeF0123456789aBcDeF0123456789aBcDeF01";
const SOL_ADDR = "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5";

const NO_FEES: FeeTotals = { gas: 0.01, service: 0.01, lp: 0, total: 0.02 };

// The env test URLs (vitest.config webTestEnv) keyed by chain for the fake rpc.
const URLS: Record<string, number> = {
  "https://eth-mainnet.g.alchemy.com/v2/test": 1,
  "https://base-mainnet.g.alchemy.com/v2/test": 8453,
  "https://arb-mainnet.g.alchemy.com/v2/test": 42161,
  "https://bnb-mainnet.g.alchemy.com/v2/test": 56,
  "https://rpc.xlayer.tech": 196,
  "https://solana-mainnet.g.alchemy.com/v2/test": 101,
};

type Fixture = {
  /** chainId → [token, rawBalance][] */
  evmBalances?: Record<number, [string, string][]>;
  /** tokenLower → { symbol, decimals } (missing = metadata-less spam) */
  metadata?: Record<string, { symbol: string; decimals: number } | null>;
  /** [mint, rawAmount, decimals][] returned for the FIRST Solana program only. */
  solAccounts?: [string, string, number][];
  /** chainIds whose rpc calls die with a transport error. */
  deadChains?: number[];
  /** chainIds whose rpc calls die with method-not-found. */
  unsupportedChains?: number[];
  /** tokenLower → usd price (missing = unpriceable). */
  prices?: Record<string, number>;
  /** tokenLower → quoted fees (missing = NO_FEES; "throw" = quote failure). */
  quotes?: Record<string, FeeTotals | "throw">;
};

function fakeDeps(fx: Fixture): DustScanDeps {
  return {
    async rpc(url, method, params) {
      const chainId = URLS[url];
      if (fx.deadChains?.includes(chainId)) throw new Error("ECONNREFUSED");
      if (fx.unsupportedChains?.includes(chainId)) {
        throw new RpcMethodUnsupported(`${method} not available`);
      }
      if (method === "alchemy_getTokenBalances") {
        return {
          tokenBalances: (fx.evmBalances?.[chainId] ?? []).map(
            ([contractAddress, tokenBalance]) => ({ contractAddress, tokenBalance }),
          ),
        };
      }
      if (method === "alchemy_getTokenMetadata") {
        const token = (params[0] as string).toLowerCase();
        return fx.metadata?.[token] ?? null;
      }
      if (method === "getTokenAccountsByOwner") {
        const program = (params[1] as { programId: string }).programId;
        if (program !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
          return { value: [] };
        }
        return {
          value: (fx.solAccounts ?? []).map(([mint, amount, decimals]) => ({
            account: {
              data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } },
            },
          })),
        };
      }
      throw new Error(`unexpected rpc method ${method}`);
    },
    async prices(pairs) {
      const map = new Map<string, number>();
      for (const p of pairs) {
        const price = fx.prices?.[p.address.toLowerCase()];
        if (price != null) map.set(`${p.network}:${p.address.toLowerCase()}`, price);
      }
      return map;
    },
    async quoteSell({ token }) {
      const q = fx.quotes?.[token.toLowerCase()];
      if (q === "throw") throw new Error("no route");
      return q ?? NO_FEES;
    },
  };
}

const scan = (fx: Fixture, uaSolAddr = SOL_ADDR) =>
  scanDust({ eoaAddr: EOA, uaSolAddr }, fakeDeps(fx));

// A well-known non-primary ERC-20 (LINK on Ethereum) used as happy-path dust.
const LINK = "0x514910771AF9Ca656af840dff83E8264EcF986CA";
const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"; // Base
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // Solana mint

describe("SUPPORTED_PRIMARY_TOKENS (runtime shape the exclusion set relies on)", () => {
  it("is a non-empty list of {chainId, address} rows", () => {
    expect(SUPPORTED_PRIMARY_TOKENS.length).toBeGreaterThan(0);
    for (const t of SUPPORTED_PRIMARY_TOKENS) {
      expect(typeof t.chainId).toBe("number");
      expect(typeof t.address).toBe("string");
    }
  });
});

describe("exclusion rules (silent — not dust at all)", () => {
  it("excludes every primary asset (already buying power)", async () => {
    // Any primary with a real (non-native-sentinel) contract address.
    const primary = SUPPORTED_PRIMARY_TOKENS.find(
      (t) => t.chainId !== 101 && !t.address.startsWith("0x0000000000"),
    );
    expect(primary).toBeDefined();
    const res = await scan({
      evmBalances: { [primary!.chainId]: [[primary!.address, "0xf4240"]] },
      metadata: {
        [primary!.address.toLowerCase()]: { symbol: "USDC", decimals: 6 },
      },
      prices: { [primary!.address.toLowerCase()]: 1 },
    });
    expect(res.items).toEqual([]);
    // Silent: it is not "skipped", it simply is not dust.
    expect(res.skipped.filter((s) => s.token)).toEqual([]);
  });

  it("excludes registry holdings (the portfolio, not dust)", async () => {
    const spyx = REGISTRY.find((a) => a.id === "spyx")!;
    const res = await scan({
      solAccounts: [[spyx.address, "5000000", 6]],
      prices: { [spyx.address.toLowerCase()]: 600 },
    });
    expect(res.items).toEqual([]);
    expect(res.skipped.filter((s) => s.token)).toEqual([]);
  });

  it("excludes a tokenized-gold (rwa-gold) balance on Ethereum — a holding, not dust (doc 20)", async () => {
    const paxg = REGISTRY.find((a) => a.id === "paxg")!;
    expect(paxg.chainId).toBe(1);
    const res = await scan({
      evmBalances: { 1: [[paxg.address, "0x2386f26fc10000"]] }, // 0.01 PAXG
      metadata: {
        [paxg.address.toLowerCase()]: { symbol: "PAXG", decimals: 18 },
      },
      prices: { [paxg.address.toLowerCase()]: 4000 },
    });
    // Gold is a portfolio position; the sweep must never scoop it up.
    expect(res.items).toEqual([]);
    expect(res.skipped.filter((s) => s.token)).toEqual([]);
  });

  it("buildExclusionSet composes primaries + registry (incl. chain-1 gold)", () => {
    const set = buildExclusionSet();
    const spyx = REGISTRY.find((a) => a.id === "spyx")!;
    const paxg = REGISTRY.find((a) => a.id === "paxg")!;
    expect(set.has(`101:${spyx.address.toLowerCase()}`)).toBe(true);
    expect(set.has(`1:${paxg.address.toLowerCase()}`)).toBe(true);
    for (const t of SUPPORTED_PRIMARY_TOKENS) {
      expect(set.has(`${t.chainId}:${t.address.toLowerCase()}`)).toBe(true);
    }
  });
});

describe("value rules", () => {
  const candidate = {
    chainId: 1,
    token: LINK,
    symbol: "LINK",
    decimals: 18,
    amountRaw: (10n ** 16n).toString(), // 0.01 LINK
  };

  it("drops a $0.10 token below the $0.25 floor, with the reason", async () => {
    const res = await scan({
      evmBalances: { 1: [[LINK, "0x2386f26fc10000"]] }, // 0.01e18
      metadata: { [LINK.toLowerCase()]: { symbol: "LINK", decimals: 18 } },
      prices: { [LINK.toLowerCase()]: 10 }, // 0.01 × $10 = $0.10
    });
    expect(res.items).toEqual([]);
    expect(res.skipped).toContainEqual(
      expect.objectContaining({ token: LINK, reason: "below-floor" }),
    );
  });

  it("treats unpriceable tokens as spam (no-price)", () => {
    expect(applyValueRules(candidate, null)).toEqual({
      kind: "skip",
      reason: "no-price",
    });
    expect(applyValueRules(candidate, 0)).toEqual({
      kind: "skip",
      reason: "no-price",
    });
  });

  it("keeps a token exactly at the floor", () => {
    const verdict = applyValueRules(candidate, DUST_FLOOR_USD / 0.01);
    expect(verdict).toEqual({ kind: "keep", usd: DUST_FLOOR_USD });
  });
});

describe("fee rule (quoted fees ≥ value is anti-user)", () => {
  it("drops the leg with an honest reason", async () => {
    const res = await scan({
      evmBalances: { 1: [[LINK, "0x2386f26fc10000"]] }, // 0.01 LINK
      metadata: { [LINK.toLowerCase()]: { symbol: "LINK", decimals: 18 } },
      prices: { [LINK.toLowerCase()]: 30 }, // $0.30
      quotes: {
        [LINK.toLowerCase()]: { gas: 0.3, service: 0.1, lp: 0, total: 0.4 },
      },
    });
    expect(res.items).toEqual([]);
    expect(res.skipped).toContainEqual(
      expect.objectContaining({
        token: LINK,
        reason: "fees-exceed-value",
        usd: expect.closeTo(0.3, 5),
      }),
    );
  });

  it("feesExceedValue is a ≥ comparison", () => {
    expect(feesExceedValue(0.3, { gas: 0, service: 0, lp: 0, total: 0.3 })).toBe(true);
    expect(feesExceedValue(0.31, { gas: 0, service: 0, lp: 0, total: 0.3 })).toBe(false);
  });
});

describe("continue-and-report per source", () => {
  it("one dead endpoint yields a source-unavailable row, scan proceeds", async () => {
    const res = await scan({
      deadChains: [1],
      evmBalances: { 8453: [[DEGEN, "0x8ac7230489e80000"]] }, // 10 DEGEN
      metadata: { [DEGEN.toLowerCase()]: { symbol: "DEGEN", decimals: 18 } },
      prices: { [DEGEN.toLowerCase()]: 0.5 },
    });
    expect(res.skipped).toContainEqual({ chainId: 1, reason: "source-unavailable" });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ chainId: 8453, symbol: "DEGEN", usd: 5 });
  });

  it("a method-not-found endpoint (X Layer public RPC) reports source-unsupported", async () => {
    const res = await scan({ unsupportedChains: [196] });
    expect(res.skipped).toContainEqual({ chainId: 196, reason: "source-unsupported" });
  });

  it("an un-bootstrapped Solana address is a skipped source, not a crash", async () => {
    const res = await scan({}, "");
    expect(res.skipped).toContainEqual({ chainId: 101, reason: "source-unavailable" });
  });

  it("a failed quote skips that leg only", async () => {
    const res = await scan({
      evmBalances: {
        1: [
          [LINK, "0xde0b6b3a7640000"], // 1 LINK
          [DEGEN, "0x8ac7230489e80000"], // 10 DEGEN (pretend it's on eth)
        ],
      },
      metadata: {
        [LINK.toLowerCase()]: { symbol: "LINK", decimals: 18 },
        [DEGEN.toLowerCase()]: { symbol: "DEGEN", decimals: 18 },
      },
      prices: { [LINK.toLowerCase()]: 10, [DEGEN.toLowerCase()]: 0.5 },
      quotes: { [LINK.toLowerCase()]: "throw" },
    });
    expect(res.items.map((i) => i.symbol)).toEqual(["DEGEN"]);
    expect(res.skipped).toContainEqual(
      expect.objectContaining({ token: LINK, reason: "quote-failed" }),
    );
  });
});

describe("happy path across sources", () => {
  it("finds dust on two networks, totals it, aggregates fees, sorts desc", async () => {
    const res = await scan({
      evmBalances: { 8453: [[DEGEN, "0x8ac7230489e80000"]] }, // 10 → $5
      metadata: { [DEGEN.toLowerCase()]: { symbol: "DEGEN", decimals: 18 } },
      solAccounts: [[BONK, "120000000", 5]], // 1200 BONK
      prices: { [DEGEN.toLowerCase()]: 0.5, [BONK.toLowerCase()]: 0.01 }, // $5 + $12
      quotes: {
        [DEGEN.toLowerCase()]: { gas: 0.02, service: 0.01, lp: 0, total: 0.03 },
        [BONK.toLowerCase()]: { gas: 0.01, service: 0.02, lp: 0.01, total: 0.04 },
      },
    });
    expect(res.items.map((i) => [i.chainId, i.usd])).toEqual([
      [101, 12],
      [8453, 5],
    ]);
    expect(res.totalUsd).toBeCloseTo(17, 10);
    expect(res.fees).toEqual({
      gas: expect.closeTo(0.03, 10),
      service: expect.closeTo(0.03, 10),
      lp: expect.closeTo(0.01, 10),
      total: expect.closeTo(0.07, 10),
    });
    // amountHuman is the human-decimal string a sell takes.
    expect(res.items.find((i) => i.chainId === 8453)?.amountHuman).toBe("10.0");
    expect(res.items.find((i) => i.chainId === 101)?.amountHuman).toBe("1200.0");
  });

  it("drops metadata-less (spam-shaped) contracts before pricing", async () => {
    const res = await scan({
      evmBalances: { 1: [["0x9999999999999999999999999999999999999999", "0x1"]] },
      metadata: {},
    });
    expect(res.items).toEqual([]);
  });
});

describe("humanAmount", () => {
  it("converts base units by real decimals", () => {
    expect(humanAmount({ amountRaw: "1500000", decimals: 6 })).toBe("1.5");
  });

  it("floor-truncates beyond 18 fractional digits (SDK parses at 18)", () => {
    expect(humanAmount({ amountRaw: "1000000000000000000000001", decimals: 24 })).toBe("1");
    expect(
      humanAmount({ amountRaw: "1123456789012345678901234", decimals: 24 }),
    ).toBe("1.123456789012345678");
  });
});
