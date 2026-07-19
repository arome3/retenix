// Module 13 — planner + terminal-verifier matrix. The planner is pure; the
// verifier is exercised through the REAL pollToTerminal against a mocked
// getTransaction (the lifecycle.test.ts pattern).
import { REGISTRY } from "@retenix/registry";
import type { KillLegPayload, MarkValue } from "@retenix/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildKillReceipt,
  legAcceptAddresses,
  planKillLegs,
  verifyLegTerminal,
  type PrimaryAssetInput,
} from "./kill";

const spyx = REGISTRY.find((a) => a.id === "spyx")!;
const tslax = REGISTRY.find((a) => a.id === "tslax")!;
const nvdax = REGISTRY.find((a) => a.id === "nvdax")!;
const paxg = REGISTRY.find((a) => a.id === "paxg")!;

const mark = (usd: number): MarkValue => ({ usd, stale: false, source: "jupiter" });

const MARKS = new Map<string, MarkValue>([
  ["spyx", mark(650)],
  ["tslax", mark(320)],
  ["nvdax", mark(180)],
  ["paxg", mark(4000)], // ~1 troy oz of gold
]);

const primary = (
  tokenType: string,
  amountInUSD: number,
  chains: [number, number][] = [[42161, amountInUSD]],
): PrimaryAssetInput => ({
  tokenType,
  amountInUSD,
  chainAggregation: chains.map(([chainId, usd]) => ({
    amountInUSD: usd,
    token: { chainId },
  })),
});

describe("planKillLegs", () => {
  it("DoD shape: 3 positions + 2 primaries → 3 sells + 2 converts, USDC untouched", () => {
    const { legs, skipped } = planKillLegs({
      positions: [
        { assetId: "spyx", qty: 0.05, qtyHuman: "0.05" },
        { assetId: "tslax", qty: 0.1, qtyHuman: "0.1" },
        { assetId: "nvdax", qty: 0.2, qtyHuman: "0.2" },
      ],
      primaries: [primary("eth", 10), primary("sol", 8), primary("usdc", 55)],
      marks: MARKS,
    });
    expect(legs.filter((l) => l.kind === "sell")).toHaveLength(3);
    expect(legs.filter((l) => l.kind === "convert")).toHaveLength(2);
    expect(legs.map((l) => l.assetId)).toEqual(["spyx", "tslax", "nvdax", "eth", "sol"]);
    // USDC produces neither a leg nor a skip — it IS the destination.
    expect(legs.some((l) => l.assetId === "usdc")).toBe(false);
    expect(skipped).toEqual([]);
  });

  it("sol/eth ledger positions are subsumed by the convert legs (never double-liquidated)", () => {
    const { legs } = planKillLegs({
      positions: [
        { assetId: "sol", qty: 0.1, qtyHuman: "0.1" },
        { assetId: "eth", qty: 0.002, qtyHuman: "0.002" },
      ],
      primaries: [primary("sol", 15), primary("eth", 6)],
      marks: MARKS,
    });
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.kind === "convert")).toBe(true);
    expect(legs.some((l) => l.kind === "sell")).toBe(false);
  });

  it("a sol/eth position with no convertible primary is listed as skipped, never silent", () => {
    const { legs, skipped } = planKillLegs({
      positions: [{ assetId: "sol", qty: 0.001, qtyHuman: "0.001" }],
      primaries: [primary("sol", 0.2)], // below the $0.50 floor
      marks: MARKS,
    });
    expect(legs).toHaveLength(0);
    // one skip from the sub-floor primary, one from the orphaned position
    expect(skipped.map((s) => s.reason)).toEqual(["below-floor", "below-floor"]);
  });

  it("qtyHuman reaches the sell leg byte-identical (sell-all never floats)", () => {
    const qtyHuman = "0.050000001"; // would round-trip badly through Number
    const { legs } = planKillLegs({
      positions: [{ assetId: "spyx", qty: 0.050000001, qtyHuman }],
      primaries: [],
      marks: MARKS,
    });
    expect(legs[0].amountHuman).toBe(qtyHuman);
    expect(legs[0].token).toBe(spyx.address);
    expect(legs[0].chainId).toBe(101);
    expect(legs[0].network).toBe("Solana");
  });

  it("haircut math: $10.00 primary → expectUsdc 9.80; floor: $0.30 skipped", () => {
    const { legs, skipped } = planKillLegs({
      positions: [],
      primaries: [primary("eth", 10), primary("bnb", 0.3)],
      marks: MARKS,
    });
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      kind: "convert",
      assetId: "eth",
      expectUsdc: 9.8,
      primaryType: "eth",
      usdEst: 10,
    });
    expect(skipped).toEqual([
      { assetId: "bnb", symbol: "BNB", usd: 0.3, reason: "below-floor" },
    ]);
  });

  it("convert destination = the chain holding most of the primary", () => {
    const { legs } = planKillLegs({
      positions: [],
      primaries: [
        primary("eth", 20, [
          [1, 4],
          [8453, 12],
          [42161, 4],
        ]),
      ],
      marks: MARKS,
    });
    expect(legs[0].chainId).toBe(8453);
    expect(legs[0].network).toBe("Base");
  });

  it("unknown position assetId → skipped with unknown-asset, never a throw", () => {
    const { legs, skipped } = planKillLegs({
      positions: [{ assetId: "mystery", qty: 1, qtyHuman: "1" }],
      primaries: [],
      marks: MARKS,
    });
    expect(legs).toHaveLength(0);
    expect(skipped).toEqual([
      { assetId: "mystery", symbol: "MYSTERY", reason: "unknown-asset" },
    ]);
  });

  it("no mark → usdEst null (renders '—', never a guessed number)", () => {
    const { legs } = planKillLegs({
      positions: [{ assetId: "spyx", qty: 0.05, qtyHuman: "0.05" }],
      primaries: [],
      marks: new Map(),
    });
    expect(legs[0].usdEst).toBeNull();
  });

  it("zero positions + zero primaries → empty plan", () => {
    expect(planKillLegs({ positions: [], primaries: [], marks: MARKS })).toEqual({
      legs: [],
      skipped: [],
    });
  });

  // ── Tokenized gold (doc 20): rwa-gold liquidates like an equity — a sell leg
  //    to USDC on Ethereum — NOT subsumed by a primary convert (it isn't one). ──
  it("a gold (rwa-gold) position becomes a SELL leg on Ethereum, not a skip", () => {
    const { legs, skipped } = planKillLegs({
      positions: [{ assetId: "paxg", qty: 0.01, qtyHuman: "0.01" }],
      primaries: [],
      marks: MARKS,
    });
    expect(skipped).toEqual([]);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      kind: "sell",
      assetId: "paxg",
      symbol: "PAXG",
      chainId: 1,
      network: "Ethereum",
      token: paxg.address,
      amountHuman: "0.01",
      usdEst: 40, // 0.01 * $4000
    });
  });

  it("gold sell-all qty reaches the leg byte-identical (no float round-trip)", () => {
    const qtyHuman = "0.012345678901234567"; // 18-dp PAXG
    const { legs } = planKillLegs({
      positions: [{ assetId: "paxg", qty: 0.012345678901234567, qtyHuman }],
      primaries: [],
      marks: MARKS,
    });
    expect(legs[0].amountHuman).toBe(qtyHuman);
  });

  it("mixed three-class kill: equity sell + gold sell + crypto convert", () => {
    const { legs, skipped } = planKillLegs({
      positions: [
        { assetId: "spyx", qty: 0.05, qtyHuman: "0.05" },
        { assetId: "paxg", qty: 0.01, qtyHuman: "0.01" },
      ],
      primaries: [primary("sol", 8), primary("usdc", 20)],
      marks: MARKS,
    });
    expect(skipped).toEqual([]);
    // spyx sell (Solana) + paxg sell (Ethereum) + sol convert; USDC untouched.
    expect(legs.map((l) => `${l.kind}:${l.assetId}`)).toEqual([
      "sell:spyx",
      "sell:paxg",
      "convert:sol",
    ]);
    const goldLeg = legs.find((l) => l.assetId === "paxg")!;
    expect(goldLeg.chainId).toBe(1);
    expect(goldLeg.network).toBe("Ethereum");
  });

  it("gold with no mark → usdEst null (never a guessed number)", () => {
    const { legs } = planKillLegs({
      positions: [{ assetId: "paxg", qty: 0.01, qtyHuman: "0.01" }],
      primaries: [],
      marks: new Map(),
    });
    expect(legs[0].usdEst).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// legAcceptAddresses
// ---------------------------------------------------------------------------

describe("legAcceptAddresses", () => {
  it("sell legs accept the registry asset's addresses", () => {
    const accept = legAcceptAddresses({ kind: "sell", assetId: "tslax" });
    expect(accept).toContain(tslax.address);
  });

  it("convert legs accept the primary's per-chain addresses (SDK list)", () => {
    const accept = legAcceptAddresses({
      kind: "convert",
      assetId: "eth",
      primaryType: "eth",
    });
    expect(accept.length).toBeGreaterThan(0);
    // native ETH sentinel appears in the SDK's primary list
    expect(accept.some((a) => a === "0x0000000000000000000000000000000000000000")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyLegTerminal (real pollToTerminal over a mocked getTransaction)
// ---------------------------------------------------------------------------

const SESSION = {
  eoaAddr: "0x8FdfCbCc3FB3d5Cf971685Fd44a36F7e363d456D",
  uaSolAddr: "7nYabs9dUhvxYwBK9A9vzM8HrbTqTPUcJUf37BLQpump",
};

const baseLeg = (over: Partial<KillLegPayload> = {}): KillLegPayload => ({
  killId: "k-1",
  legId: "l-1",
  kind: "sell",
  assetId: "nvdax",
  symbol: "NVDAx",
  chainId: 101,
  network: "Solana",
  token: nvdax.address,
  amountHuman: "0.2",
  usdEst: 36,
  outcome: "submitted",
  attempt: 1,
  ...over,
});

const FEES = { gas: 0.02, service: 0.05, lp: 0.01, total: 0.08 };

/** A FINISHED payload whose tokenChanges show this leg's token leaving. */
const finishedTx = (over: Record<string, unknown> = {}) => ({
  status: 7,
  smartAccountOptions: { ownerAddress: SESSION.eoaAddr },
  tokenChanges: {
    decr: [{ token: { address: nvdax.address }, amount: "0.2", amountInUSD: "35.80" }],
  },
  feeQuotes: [
    {
      fees: {
        totals: {
          gasFeeTokenAmountInUSD: (0.02e18).toString(),
          transactionServiceFeeTokenAmountInUSD: (0.05e18).toString(),
          transactionLPFeeTokenAmountInUSD: (0.01e18).toString(),
          feeTokenAmountInUSD: (0.08e18).toString(),
        },
      },
    },
  ],
  ...over,
});

const uaOf = (t: unknown) => ({ getTransaction: vi.fn().mockResolvedValue(t) });

afterEach(() => {
  vi.useRealTimers();
});

describe("verifyLegTerminal", () => {
  it("finished + owner match + asset match → settled, server's own qty/usd/fees", async () => {
    const v = await verifyLegTerminal(
      { ua: uaOf(finishedTx()) },
      baseLeg(),
      "tx_settled_1",
      SESSION,
    );
    expect(v).toMatchObject({
      kind: "verified",
      state: "settled",
      patch: {
        transactionId: "tx_settled_1",
        serverVerified: true,
        qty: 0.2,
        usd: 35.8,
        feeSource: "settled",
        receipt: "Sold NVDAx — now USDC in your balance.",
      },
    });
    if (v.kind !== "verified") throw new Error("unreachable");
    expect(v.patch.fees).toEqual(FEES);
  });

  it("finished + owner match + NO matching token decr → unverified, never a fill", async () => {
    const foreign = finishedTx({
      tokenChanges: { decr: [{ token: { address: spyx.address }, amount: "1" }] },
    });
    const v = await verifyLegTerminal(
      { ua: uaOf(foreign) },
      baseLeg(),
      "tx_other_asset",
      SESSION,
    );
    expect(v).toMatchObject({
      kind: "verified",
      state: "unverified",
      patch: { serverVerified: false },
    });
    if (v.kind !== "verified") throw new Error("unreachable");
    expect(v.patch.qty).toBeUndefined();
    expect(v.patch.usd).toBeUndefined();
    expect(v.patch.receipt).toBe("NVDAx liquidation couldn't be verified — you can retry.");
  });

  it("foreign owner → failed with the account-mismatch error", async () => {
    const foreign = finishedTx({
      smartAccountOptions: { ownerAddress: "0x000000000000000000000000000000000000dEaD" },
    });
    const v = await verifyLegTerminal(
      { ua: uaOf(foreign) },
      baseLeg(),
      "tx_foreign",
      SESSION,
    );
    expect(v).toMatchObject({
      kind: "verified",
      state: "failed",
      patch: { error: "did not match this account" },
    });
  });

  it("REFUND (UA 8–11) → refunded with the doc-08 wording", async () => {
    const refund = finishedTx({ status: 9, tokenChanges: undefined });
    const v = await verifyLegTerminal(
      { ua: uaOf(refund) },
      baseLeg(),
      "tx_refund",
      SESSION,
    );
    expect(v).toMatchObject({ kind: "verified", state: "refunded" });
    if (v.kind !== "verified") throw new Error("unreachable");
    // no extraction available → the planning estimate is the honest fallback
    expect(v.patch.receipt).toBe("Didn't complete — your $36.00 was returned");
  });

  it("poll throw → still-settling (no state change; the caller CONFLICTs)", async () => {
    const ua = { getTransaction: vi.fn().mockRejectedValue(new Error("504")) };
    const v = await verifyLegTerminal({ ua }, baseLeg(), "tx_slow", SESSION);
    expect(v).toEqual({ kind: "still-settling" });
  });

  it("poll timeout (still in flight) → still-settling", async () => {
    vi.useFakeTimers();
    const ua = { getTransaction: vi.fn().mockResolvedValue({ status: 3 }) };
    const pending = verifyLegTerminal({ ua }, baseLeg(), "tx_inflight", SESSION);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ kind: "still-settling" });
  });

  it("quoted fees are the honest fallback when the settled payload has none", async () => {
    const noFees = finishedTx({ feeQuotes: [] });
    const v = await verifyLegTerminal(
      { ua: uaOf(noFees) },
      baseLeg(),
      "tx_nofees",
      SESSION,
      FEES,
    );
    if (v.kind !== "verified") throw new Error("unreachable");
    expect(v.patch.feeSource).toBe("quoted");
    expect(v.patch.fees).toEqual(FEES);
  });
});

// ---------------------------------------------------------------------------
// buildKillReceipt
// ---------------------------------------------------------------------------

describe("buildKillReceipt", () => {
  const started = {
    killId: "k-1",
    executeReceivedAtMs: 1,
    revoke: { state: "confirmed" as const, txHash: "0xr" },
    planIds: ["p1"],
    skipped: [],
    legCount: 3,
  };

  it("honest counts + summed settled fees + SweepReceiptLeg-shaped legs", () => {
    const legs: KillLegPayload[] = [
      baseLeg({ legId: "a", outcome: "settled", usd: 35.8, fees: FEES, feeSource: "settled", transactionId: "t_a12345678", serverVerified: true }),
      baseLeg({ legId: "b", assetId: "spyx", symbol: "SPYx", outcome: "failed", error: "quote expired" }),
      baseLeg({ legId: "c", assetId: "eth", symbol: "ETH", kind: "convert", outcome: "refunded" }),
    ];
    const receipt = buildKillReceipt(started, legs);
    expect(receipt.receipt).toBe(
      "Liquidated 1 of 3 positions to USDC · all agents revoked · 2 legs need retry",
    );
    expect(receipt).toMatchObject({ liquidated: 1, total: 3, retryable: 2, revoked: true });
    expect(receipt.fees).toEqual(FEES); // only the settled leg's fees
    expect(receipt.legs).toHaveLength(3);
    expect(receipt.legs[0]).toMatchObject({
      network: "Solana",
      symbol: "NVDAx",
      usd: 35.8,
      outcome: "settled",
      serverVerified: true,
      transactionId: "t_a12345678",
    });
    expect(receipt.legs[1]).toMatchObject({ outcome: "failed", error: "quote expired" });
  });

  it("failed revoke never claims revoked", () => {
    const receipt = buildKillReceipt(
      { ...started, revoke: { state: "failed", error: "no gas" } },
      [baseLeg({ outcome: "settled" })],
    );
    expect(receipt.revoked).toBe(false);
    expect(receipt.receipt).toContain("agent revocation still pending");
  });

  it("zero legs → the zero variant", () => {
    const receipt = buildKillReceipt(started, []);
    expect(receipt.receipt).toBe("Nothing to liquidate — all agents revoked");
    expect(receipt.legs).toEqual([]);
  });
});
