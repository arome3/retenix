import type { IAssetsResponse } from "@retenix/ua";
import { afterEach, describe, expect, it, vi } from "vitest";
import { summarize, summaryCache } from "./summary";

// Minimal structurally-valid IToken rows (the fold reads only token.chainId).
const token = (chainId: number) =>
  ({ chainId, address: "0x0", decimals: 18, realDecimals: 18 }) as never;

const agg = (chainId: number, amountInUSD: number) => ({
  token: token(chainId),
  amount: 0,
  amountInUSD,
  rawAmount: 0,
});

// Demo beat 1's shape: $212.40 sourced from 4 networks (PS-6.1).
const BEAT_1 = {
  totalAmountInUSD: 212.4,
  assets: [
    {
      tokenType: "usdc",
      price: 1,
      amount: 150,
      amountInUSD: 150,
      chainAggregation: [agg(8453, 100), agg(42161, 50)],
    },
    {
      tokenType: "eth",
      price: 2020,
      amount: 0.02,
      amountInUSD: 40.4,
      chainAggregation: [agg(1, 40.4), agg(56, 0)], // zero row must not count
    },
    {
      tokenType: "sol",
      price: 110,
      amount: 0.2,
      amountInUSD: 22,
      chainAggregation: [agg(101, 22)],
    },
    { tokenType: "usdt", price: 1, amount: 0, amountInUSD: 0, chainAggregation: [] },
    {
      tokenType: "bnb",
      price: 600,
      amount: 0,
      amountInUSD: 0,
      chainAggregation: [agg(56, 0)],
    },
  ],
} as unknown as IAssetsResponse;

const AS_OF = new Date("2026-07-13T10:00:00.000Z");

describe("summarize (doc 06 aggregation math)", () => {
  it("sums the five primaries across chains into one buying-power number", () => {
    const s = summarize(BEAT_1, AS_OF);
    expect(s.buyingPowerUsd).toBeCloseTo(212.4, 10);
    expect(s.asOf).toBe("2026-07-13T10:00:00.000Z");
  });

  it("groups per-network sources (usd > 0 only), largest first, with names and %", () => {
    const s = summarize(BEAT_1, AS_OF);
    expect(s.sources.map((x) => [x.chainId, x.name, x.usd])).toEqual([
      [8453, "Base", 100],
      [42161, "Arbitrum", 50],
      [1, "Ethereum", 40.4],
      [101, "Solana", 22],
    ]);
    expect(s.sources.map((x) => x.pct)).toEqual([47.08, 23.54, 19.02, 10.36]);
    // Percentages are display-rounded to hundredths and re-total to ~100.
    expect(s.sources.reduce((sum, x) => sum + x.pct, 0)).toBeCloseTo(100, 1);
    // The pill count IS sources.length — 4 here (PS-F2-AC3, demo beat 1).
    expect(s.sources).toHaveLength(4);
  });

  it("emits per-asset rows with per-chain provenance, zero-balance assets dropped", () => {
    const s = summarize(BEAT_1, AS_OF);
    expect(s.assets.map((a) => a.symbol)).toEqual(["USDC", "ETH", "SOL"]);
    expect(s.assets[0].perChain).toEqual([
      { chainId: 8453, usd: 100 },
      { chainId: 42161, usd: 50 },
    ]);
  });

  it("handles an empty account without NaN: zero total, no sources, no assets", () => {
    const s = summarize({ totalAmountInUSD: 0, assets: [] } as unknown as IAssetsResponse, AS_OF);
    expect(s).toEqual({ buyingPowerUsd: 0, sources: [], assets: [], asOf: AS_OF.toISOString() });
  });

  it("guards a malformed response (missing arrays) rather than throwing", () => {
    const s = summarize({} as IAssetsResponse, AS_OF);
    expect(s.buyingPowerUsd).toBe(0);
    expect(s.sources).toEqual([]);
  });
});

describe("summaryCache (PROPOSED 30s TTL + stale-forever fallback)", () => {
  afterEach(() => {
    summaryCache.clear();
    vi.useRealTimers();
  });

  it("serves a fresh entry inside the TTL and expires it after", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T10:00:00.000Z"));
    const s = summarize(BEAT_1, new Date());
    summaryCache.set("u1", s);

    vi.setSystemTime(new Date("2026-07-13T10:00:29.000Z"));
    expect(summaryCache.fresh("u1")).toBe(s);

    vi.setSystemTime(new Date("2026-07-13T10:00:31.000Z"));
    expect(summaryCache.fresh("u1")).toBeNull();
  });

  it("stale() keeps serving the last-known truth regardless of age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T10:00:00.000Z"));
    const s = summarize(BEAT_1, new Date());
    summaryCache.set("u1", s);

    vi.setSystemTime(new Date("2026-07-13T12:00:00.000Z")); // hours later
    expect(summaryCache.fresh("u1")).toBeNull();
    expect(summaryCache.stale("u1")).toBe(s); // old asOf → C1's stale marker
  });

  it("is per-user", () => {
    const s = summarize(BEAT_1, new Date());
    summaryCache.set("u1", s);
    expect(summaryCache.stale("u2")).toBeNull();
  });
});
