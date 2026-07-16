import { describe, expect, it } from "vitest";

import { computeLegs } from "./basket";

describe("computeLegs (doc 08 basket splitting)", () => {
  it("canonical: $25 weekly 60/30/10 → $15.00 / $7.50 / $2.50, seq 0..2", () => {
    expect(
      computeLegs({
        amountUsd: 25,
        basket: [
          { assetId: "spyx", pct: 60 },
          { assetId: "tslax", pct: 30 },
          { assetId: "sol", pct: 10 },
        ],
      }),
    ).toEqual([
      { seq: 0, assetId: "spyx", usd: 15 },
      { seq: 1, assetId: "tslax", usd: 7.5 },
      { seq: 2, assetId: "sol", usd: 2.5 },
    ]);
  });

  it("legs below $1.00 merge into the largest leg, never dropped (PS-F4.1)", () => {
    expect(
      computeLegs({
        amountUsd: 10,
        basket: [
          { assetId: "sol", pct: 5 }, // $0.50 — below minimum
          { assetId: "spyx", pct: 47.5 },
          { assetId: "tslax", pct: 47.5 },
        ],
      }),
    ).toEqual([
      { seq: 0, assetId: "spyx", usd: 5.25 }, // 4.75 + 0.50 (largest tie → lowest index)
      { seq: 1, assetId: "tslax", usd: 4.75 },
    ]);
  });

  it("folds cent-rounding drift into the largest leg so legs sum exactly", () => {
    const third = 100 / 3;
    const legs = computeLegs({
      amountUsd: 10,
      basket: [
        { assetId: "a", pct: third },
        { assetId: "b", pct: third },
        { assetId: "c", pct: third },
      ],
    });
    expect(legs.map((l) => l.usd)).toEqual([3.34, 3.33, 3.33]);
    expect(legs.reduce((s, l) => s + l.usd * 100, 0)).toBe(1000);
  });

  it("an all-sub-$1 basket collapses to a single full-amount leg", () => {
    expect(
      computeLegs({
        amountUsd: 2,
        basket: [
          { assetId: "a", pct: 34 },
          { assetId: "b", pct: 33 },
          { assetId: "c", pct: 33 },
        ],
      }),
    ).toEqual([{ seq: 0, assetId: "a", usd: 2 }]);
  });

  it("is deterministic and sum-exact under fuzz (seeded)", () => {
    let seed = 0xbeef;
    const rnd = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let i = 0; i < 300; i += 1) {
      const n = 1 + Math.floor(rnd() * 5);
      const cuts = Array.from({ length: n }, () => rnd() + 0.01);
      const total = cuts.reduce((s, c) => s + c, 0);
      const basket = cuts.map((c, j) => ({
        assetId: `asset${j}`,
        pct: (c / total) * 100,
      }));
      const amountUsd = 1 + Math.round(rnd() * 20_000) / 100; // $1..$201
      const params = { amountUsd, basket };
      const legs = computeLegs(params);
      const again = computeLegs(params);
      expect(again).toEqual(legs); // determinism — period_key stability
      const cents = legs.reduce((s, l) => s + Math.round(l.usd * 100), 0);
      expect(cents).toBe(Math.round(amountUsd * 100)); // sum invariant
      for (const l of legs) {
        expect(Math.round(l.usd * 100)).toBeGreaterThanOrEqual(
          legs.length > 1 ? 100 : Math.round(amountUsd * 100),
        );
      }
    }
  });
});
