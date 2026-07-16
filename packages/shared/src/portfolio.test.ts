import { describe, expect, it } from "vitest";
import {
  acceptableAddresses,
  assembleHoldings,
  extractSellFill,
  BASIS_QTY_TOLERANCE,
  bucketSnapshots,
  buildBasisLedger,
  extractFillQty,
  lastTradeMarks,
  parseSeqFromPeriodKey,
  ringArcs,
  ringSegments,
  roundPctsTo100,
  SOL_NATIVE_MINT,
  sparkFromSnapshots,
  type Fill,
  type PortfolioAssetMeta,
} from "./portfolio";

const SPYX_MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

const ASSETS: PortfolioAssetMeta[] = [
  {
    id: "spyx",
    ticker: "SPYx",
    name: "S&P 500 (tokenized)",
    kind: "equity",
    chainId: 101,
    address: SPYX_MINT,
    disclosure:
      "SPYx tracks the S&P 500 ETF. It is not a share — no voting rights or dividend claims. Issuer: Backed.",
  },
  {
    id: "sol",
    ticker: "SOL",
    name: "Solana",
    kind: "crypto",
    chainId: 101,
    address: "0x0000000000000000000000000000000000000000",
  },
];

const buy = (over: Partial<Fill>): Fill => ({
  side: "buy",
  assetId: "spyx",
  usd: 15,
  qty: 0.024,
  at: "2026-07-01T00:00:00.000Z",
  ...over,
});

describe("parseSeqFromPeriodKey", () => {
  const planId = "0d9c1a52-9f6b-4c1e-8f5a-2d7e6b3c4a10";

  it("reads the seq off a canonical key (ISO segment carries colons)", () => {
    expect(
      parseSeqFromPeriodKey(`${planId}:2026-07-13T12:00:00.000Z:0`),
    ).toBe(0);
    expect(
      parseSeqFromPeriodKey(`${planId}:2026-07-13T12:00:00.000Z:2`),
    ).toBe(2);
  });

  it("returns null for rogue and e2e uuid tails", () => {
    expect(
      parseSeqFromPeriodKey(`${planId}:rogue:8b8f4c1e-1111-4222-8333-9d7e6b3c4a10`),
    ).toBeNull();
    expect(
      parseSeqFromPeriodKey(`${planId}:e2e:8b8f4c1e-1111-4222-8333-9d7e6b3c4a10`),
    ).toBeNull();
  });

  it("rejects non-numeric and oversized tails", () => {
    expect(parseSeqFromPeriodKey("no-colons-at-all")).toBeNull();
    expect(parseSeqFromPeriodKey(`${planId}:2026-07-13T12:00:00.000Z:`)).toBeNull();
    expect(parseSeqFromPeriodKey(`${planId}:x:12345`)).toBeNull(); // >3 digits
  });
});

describe("extractFillQty", () => {
  const accept = acceptableAddresses(ASSETS[0]);

  it("reads tokenChanges.incr by exact mint match", () => {
    const detail = {
      tokenChanges: {
        incr: [{ token: { address: SPYX_MINT }, amount: "0.02411" }],
        swaps: [],
      },
    };
    expect(extractFillQty([detail], accept)).toBeCloseTo(0.02411);
  });

  it("prefers the settled detail over the create-time quote", () => {
    const detail = {
      tokenChanges: { incr: [{ token: { address: SPYX_MINT }, amount: "0.024" }] },
    };
    const quote = {
      tokenChanges: { incr: [{ token: { address: SPYX_MINT }, amount: "0.025" }] },
    };
    expect(extractFillQty([detail, quote], accept)).toBeCloseTo(0.024);
  });

  it("falls back to the quote when the detail knows nothing", () => {
    const quote = {
      tokenChanges: { incr: [{ token: { address: SPYX_MINT }, amount: "0.025" }] },
    };
    expect(extractFillQty([{}, quote], accept)).toBeCloseTo(0.025);
  });

  it("falls back to swaps[].toToken", () => {
    const detail = {
      tokenChanges: {
        incr: [],
        swaps: [{ toToken: { token: { address: SPYX_MINT }, amount: "0.026" } }],
      },
    };
    expect(extractFillQty([detail], accept)).toBeCloseTo(0.026);
  });

  it("matches Solana mints case-SENSITIVELY and EVM hex case-insensitively", () => {
    const wrongCase = {
      tokenChanges: {
        incr: [{ token: { address: SPYX_MINT.toLowerCase() }, amount: "1" }],
      },
    };
    expect(extractFillQty([wrongCase], accept)).toBeNull();

    const evm = {
      tokenChanges: {
        incr: [
          {
            token: { address: "0xABCDEF0000000000000000000000000000000001" },
            amount: "2",
          },
        ],
      },
    };
    expect(
      extractFillQty([evm], ["0xabcdef0000000000000000000000000000000001"]),
    ).toBe(2);
  });

  it("accepts the native SOL mint alias for the sol asset", () => {
    const solAccept = acceptableAddresses(ASSETS[1]);
    const detail = {
      tokenChanges: {
        incr: [{ token: { address: SOL_NATIVE_MINT }, amount: "0.0132" }],
      },
    };
    expect(extractFillQty([detail], solAccept)).toBeCloseTo(0.0132);
  });

  it("returns null on unrecognized, empty, or nonsensical shapes — never guesses", () => {
    expect(extractFillQty([], accept)).toBeNull();
    expect(extractFillQty([null, undefined, 42, "x"], accept)).toBeNull();
    expect(extractFillQty([{ tokenChanges: {} }], accept)).toBeNull();
    for (const amount of ["0", "-1", "NaN", "", {}, null]) {
      const detail = {
        tokenChanges: { incr: [{ token: { address: SPYX_MINT }, amount }] },
      };
      expect(extractFillQty([detail], accept)).toBeNull();
    }
  });
});

describe("extractSellFill", () => {
  const accept = acceptableAddresses(ASSETS[0]);

  it("reads the sold side (decr) with its verified USD", () => {
    const detail = {
      tokenChanges: {
        decr: [
          { token: { address: SPYX_MINT }, amount: "0.05", amountInUSD: "31.00" },
        ],
      },
    };
    expect(extractSellFill([detail], accept)).toEqual({ qty: 0.05, usd: 31 });
  });

  it("falls back to swaps[].fromToken; unknowable stays null", () => {
    const swapped = {
      tokenChanges: {
        swaps: [{ fromToken: { token: { address: SPYX_MINT }, amount: "0.02" } }],
      },
    };
    expect(extractSellFill([swapped], accept)).toEqual({ qty: 0.02, usd: null });
    expect(extractSellFill([{}], accept)).toEqual({ qty: null, usd: null });
  });
});

describe("buildBasisLedger", () => {
  it("averages multiple buys", () => {
    const ledger = buildBasisLedger([
      buy({ usd: 10, qty: 1, at: "2026-07-01T00:00:00.000Z" }),
      buy({ usd: 20, qty: 1, at: "2026-07-02T00:00:00.000Z" }),
    ]);
    const spyx = ledger.get("spyx");
    expect(spyx).toMatchObject({ qty: 2, costBasisUsd: 30, basisKnown: true });
    expect(spyx?.avgCostUsd).toBe(15);
  });

  it("reduces basis proportionally on sells (average-cost method)", () => {
    const ledger = buildBasisLedger([
      buy({ usd: 10, qty: 1, at: "2026-07-01T00:00:00.000Z" }),
      buy({ usd: 20, qty: 1, at: "2026-07-02T00:00:00.000Z" }),
      { side: "sell", assetId: "spyx", usd: 18, qty: 1, at: "2026-07-03T00:00:00.000Z" },
    ]);
    const spyx = ledger.get("spyx");
    expect(spyx?.qty).toBe(1);
    expect(spyx?.costBasisUsd).toBeCloseTo(15); // half the 30 basis left
    expect(spyx?.basisKnown).toBe(true);
  });

  it("folds in chronological order regardless of input order", () => {
    const shuffled = buildBasisLedger([
      { side: "sell", assetId: "spyx", usd: 18, qty: 1, at: "2026-07-03T00:00:00.000Z" },
      buy({ usd: 20, qty: 1, at: "2026-07-02T00:00:00.000Z" }),
      buy({ usd: 10, qty: 1, at: "2026-07-01T00:00:00.000Z" }),
    ]);
    expect(shuffled.get("spyx")?.costBasisUsd).toBeCloseTo(15);
  });

  it("a buy with unknown qty poisons basis for good — never guessed", () => {
    const ledger = buildBasisLedger([
      buy({ usd: 10, qty: 1, at: "2026-07-01T00:00:00.000Z" }),
      buy({ usd: 15, qty: null, at: "2026-07-02T00:00:00.000Z" }),
      buy({ usd: 20, qty: 1, at: "2026-07-03T00:00:00.000Z" }),
    ]);
    expect(ledger.get("spyx")?.basisKnown).toBe(false);
  });

  it("a buy with unknown usd poisons too", () => {
    const ledger = buildBasisLedger([buy({ usd: null, qty: 1 })]);
    expect(ledger.get("spyx")?.basisKnown).toBe(false);
  });

  it("selling more than the ledger holds clamps at zero; selling into an empty ledger poisons", () => {
    const oversell = buildBasisLedger([
      buy({ usd: 10, qty: 1, at: "2026-07-01T00:00:00.000Z" }),
      { side: "sell", assetId: "spyx", usd: 30, qty: 3, at: "2026-07-02T00:00:00.000Z" },
    ]);
    expect(oversell.get("spyx")?.qty).toBe(0);
    expect(oversell.get("spyx")?.costBasisUsd).toBe(0);

    const orphanSell = buildBasisLedger([
      { side: "sell", assetId: "spyx", usd: 10, qty: 1, at: "2026-07-01T00:00:00.000Z" },
    ]);
    expect(orphanSell.get("spyx")?.basisKnown).toBe(false);
  });
});

describe("lastTradeMarks", () => {
  it("takes the most recent fill with usable qty and usd", () => {
    const marks = lastTradeMarks([
      buy({ usd: 10, qty: 1, at: "2026-07-01T00:00:00.000Z" }),
      buy({ usd: 24, qty: 2, at: "2026-07-02T00:00:00.000Z" }),
      buy({ usd: 99, qty: null, at: "2026-07-03T00:00:00.000Z" }), // unusable
    ]);
    expect(marks.get("spyx")).toBe(12);
  });
});

describe("assembleHoldings", () => {
  const marks = new Map([
    ["spyx", { usd: 625, stale: false, source: "jupiter" as const }],
    ["sol", { usd: 150, stale: false, source: "jupiter" as const }],
  ]);

  it("computes value, basis, and deltas when the ledger matches the chain", () => {
    const basis = buildBasisLedger([buy({ usd: 15, qty: 0.025 })]);
    const { holdings, totals } = assembleHoldings({
      positions: [{ assetId: "spyx", qty: 0.025, qtyHuman: "0.025" }],
      basis,
      marks,
      assets: ASSETS,
    });
    expect(holdings).toHaveLength(1);
    const h = holdings[0];
    expect(h.valueUsd).toBeCloseTo(15.625);
    expect(h.costBasisUsd).toBe(15);
    expect(h.deltaUsd).toBeCloseTo(0.625);
    expect(h.deltaPct).toBeCloseTo(4.1667, 3);
    expect(h.disclosure).toContain("Issuer: Backed");
    expect(totals.totalUsd).toBeCloseTo(15.625);
    expect(totals.returnUsd).toBeCloseTo(0.625);
    expect(totals.returnPct).toBeCloseTo(4.1667, 3);
  });

  it("renders basis as unknown when chain qty drifts beyond the tolerance", () => {
    const basis = buildBasisLedger([buy({ usd: 15, qty: 0.025 })]);
    const drifted = 0.025 * (1 + BASIS_QTY_TOLERANCE * 2);
    const { holdings } = assembleHoldings({
      positions: [{ assetId: "spyx", qty: drifted }],
      basis,
      marks,
      assets: ASSETS,
    });
    expect(holdings[0].costBasisUsd).toBeNull();
    expect(holdings[0].deltaUsd).toBeNull();
    expect(holdings[0].deltaPct).toBeNull();
  });

  it("tolerates sub-tolerance drift (fill slippage)", () => {
    const basis = buildBasisLedger([buy({ usd: 15, qty: 0.025 })]);
    const slipped = 0.025 * (1 + BASIS_QTY_TOLERANCE / 2);
    const { holdings } = assembleHoldings({
      positions: [{ assetId: "spyx", qty: slipped }],
      basis,
      marks,
      assets: ASSETS,
    });
    expect(holdings[0].costBasisUsd).toBe(15);
  });

  it("omits positions with no mark and positions at zero qty; sorts by value desc", () => {
    const noSolMark = new Map([["spyx", { usd: 625, stale: true, source: "last-trade" as const }]]);
    const { holdings } = assembleHoldings({
      positions: [
        { assetId: "sol", qty: 1 }, // no mark → omitted
        { assetId: "spyx", qty: 0 }, // zero → omitted
      ],
      basis: new Map(),
      marks: noSolMark,
      assets: ASSETS,
    });
    expect(holdings).toHaveLength(0);

    const both = assembleHoldings({
      positions: [
        { assetId: "spyx", qty: 0.01 }, // $6.25
        { assetId: "sol", qty: 1 }, // $150
      ],
      basis: new Map(),
      marks,
      assets: ASSETS,
    });
    expect(both.holdings.map((h) => h.assetId)).toEqual(["sol", "spyx"]);
  });

  it("totals omit return entirely when no basis is known", () => {
    const { totals } = assembleHoldings({
      positions: [{ assetId: "spyx", qty: 0.025 }],
      basis: new Map(),
      marks,
      assets: ASSETS,
    });
    expect(totals.totalUsd).toBeCloseTo(15.625);
    expect(totals.costBasisUsd).toBe(0);
    expect(totals.returnUsd).toBeNull();
    expect(totals.returnPct).toBeNull();
  });

  it("passes markStale through for the doc-01 stale marker", () => {
    const stale = new Map([["spyx", { usd: 600, stale: true, source: "last-trade" as const }]]);
    const { holdings } = assembleHoldings({
      positions: [{ assetId: "spyx", qty: 0.025 }],
      basis: new Map(),
      marks: stale,
      assets: ASSETS,
    });
    expect(holdings[0].markStale).toBe(true);
  });
});

describe("roundPctsTo100", () => {
  it("single asset → exactly [100]", () => {
    expect(roundPctsTo100([42.37])).toEqual([100]);
  });

  it("five-asset case sums to exactly 100.00", () => {
    const pcts = roundPctsTo100([33.33, 21.17, 19.5, 15.5, 10.5]);
    expect(pcts.reduce((s, v) => s + v, 0)).toBeCloseTo(100, 10);
    expect(pcts).toHaveLength(5);
  });

  it("thirds get the largest-remainder cent: 33.33 + 33.33 + 33.34", () => {
    const pcts = roundPctsTo100([1, 1, 1]);
    expect(pcts.filter((p) => p === 33.33)).toHaveLength(2);
    expect(pcts.filter((p) => p === 33.34)).toHaveLength(1);
    expect(pcts.reduce((s, v) => s + v, 0)).toBe(100);
  });

  it("all-zero input stays all-zero", () => {
    expect(roundPctsTo100([0, 0])).toEqual([0, 0]);
  });
});

describe("ringSegments", () => {
  const h = (assetId: string, valueUsd: number) => ({
    assetId,
    ticker: assetId.toUpperCase(),
    valueUsd,
  });

  it("passes ≤5 assets through, largest first", () => {
    const segs = ringSegments([h("a", 1), h("b", 3), h("c", 2)]);
    expect(segs.map((s) => s.assetId)).toEqual(["b", "c", "a"]);
  });

  it("groups the tail into Other beyond 5 segments (PROPOSED)", () => {
    const segs = ringSegments([
      h("a", 60),
      h("b", 20),
      h("c", 10),
      h("d", 5),
      h("e", 3),
      h("f", 2),
    ]);
    expect(segs).toHaveLength(5);
    expect(segs[4]).toMatchObject({ assetId: "other", ticker: "Other", valueUsd: 5 });
  });
});

describe("ringArcs", () => {
  const r = 42;
  const C = 2 * Math.PI * r;

  it("one asset is the full circumference at offset 0", () => {
    const [arc] = ringArcs([100], r);
    expect(arc.dashoffset).toBe(0);
    const [len, gap] = arc.dasharray.split(" ").map(Number);
    expect(len).toBeCloseTo(C);
    expect(gap).toBeCloseTo(0);
  });

  it("five segments tile the circle: lengths sum to C, offsets accumulate", () => {
    const pcts = [40, 25, 15, 12, 8];
    const arcs = ringArcs(pcts, r);
    const lengths = arcs.map((a) => Number(a.dasharray.split(" ")[0]));
    expect(lengths.reduce((s, v) => s + v, 0)).toBeCloseTo(C);
    expect(arcs[0].dashoffset).toBe(0);
    expect(arcs[1].dashoffset).toBeCloseTo(-lengths[0]);
    expect(arcs[4].dashoffset).toBeCloseTo(
      -(lengths[0] + lengths[1] + lengths[2] + lengths[3]),
    );
    for (const arc of arcs) {
      const [len, gap] = arc.dasharray.split(" ").map(Number);
      expect(len + gap).toBeCloseTo(C);
    }
  });
});

describe("bucketSnapshots", () => {
  const now = Date.parse("2026-07-16T12:30:00.000Z");
  const at = (iso: string, totalUsd: number) => ({ at: iso, totalUsd });

  it("hourly buckets for 1w, last snapshot per bucket wins", () => {
    const points = bucketSnapshots(
      [
        at("2026-07-16T10:05:00.000Z", 100),
        at("2026-07-16T10:55:00.000Z", 101), // same bucket → wins
        at("2026-07-16T12:05:00.000Z", 103),
      ],
      "1w",
      now,
    );
    expect(points).toHaveLength(3); // 10:00, 11:00, 12:00
    expect(points[0]).toEqual({
      t: Date.parse("2026-07-16T10:00:00.000Z") / 1000,
      usd: 101,
    });
    expect(points[1].usd).toBeNull(); // 11:00 — worker gap renders as a hole
    expect(points[2].usd).toBe(103);
  });

  it("starts at the first snapshot (no leading emptiness) and keeps trailing gaps", () => {
    const points = bucketSnapshots(
      [at("2026-07-16T08:10:00.000Z", 90)],
      "1w",
      now,
    );
    expect(points[0].t).toBe(Date.parse("2026-07-16T08:00:00.000Z") / 1000);
    expect(points.at(-1)?.t).toBe(Date.parse("2026-07-16T12:00:00.000Z") / 1000);
    expect(points.slice(1).every((p) => p.usd === null)).toBe(true);
  });

  it("excludes snapshots outside the range window", () => {
    const points = bucketSnapshots(
      [
        at("2026-06-01T00:00:00.000Z", 50), // > 1w ago
        at("2026-07-16T11:00:00.000Z", 100),
      ],
      "1w",
      now,
    );
    expect(points.every((p) => p.usd === null || p.usd === 100)).toBe(true);
  });

  it("'all' spans from the first snapshot in daily buckets", () => {
    const points = bucketSnapshots(
      [at("2026-07-10T03:00:00.000Z", 10), at("2026-07-14T03:00:00.000Z", 20)],
      "all",
      now,
    );
    expect(points).toHaveLength(7); // Jul 10..16 inclusive
    expect(points[0].usd).toBe(10);
    expect(points[4].usd).toBe(20);
    expect(points[1].usd).toBeNull();
  });

  it("empty and unparsable input → []", () => {
    expect(bucketSnapshots([], "1m", now)).toEqual([]);
    expect(bucketSnapshots([at("not-a-date", 5)], "1m", now)).toEqual([]);
  });
});

describe("sparkFromSnapshots", () => {
  it("extracts the asset's value series, skipping malformed blobs", () => {
    const blobs = [
      { spyx: { qty: 1, markUsd: 10, valueUsd: 10 } },
      null,
      { sol: { qty: 1, markUsd: 150, valueUsd: 150 } }, // asset absent → no point
      { spyx: { qty: 1, markUsd: 11, valueUsd: 11 } },
      { spyx: { valueUsd: "not-a-number" } },
      { spyx: { qty: 1, markUsd: 12, valueUsd: 12 } },
    ];
    expect(sparkFromSnapshots(blobs, "spyx")).toEqual([10, 11, 12]);
  });

  it("hides below 2 points (doc 12: sparkline needs ≥2 else hides)", () => {
    expect(sparkFromSnapshots([{ spyx: { valueUsd: 10 } }], "spyx")).toEqual([]);
    expect(sparkFromSnapshots([], "spyx")).toEqual([]);
  });
});
