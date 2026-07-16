import { describe, expect, it } from "vitest";

import { brokerParamsSchema } from "./plan-params";

const VALID = {
  cadence: "weekly" as const,
  amountUsd: 25,
  basket: [
    { assetId: "spyx", pct: 60 },
    { assetId: "tslax", pct: 30 },
    { assetId: "sol", pct: 10 },
  ],
  capPerExecUsd: 50,
  capPerPeriodUsd: 50,
  periodSecs: 604_800,
  nextRunAt: "2026-07-23T09:30:00.000Z",
};

describe("brokerParamsSchema (worker read-contract for plans.params_json)", () => {
  it("parses the canonical $25/week 60-30-10 shape; topUpOptIn defaults false", () => {
    const parsed = brokerParamsSchema.parse(VALID);
    expect(parsed.topUpOptIn).toBe(false);
    expect(parsed.basket.map((l) => l.assetId)).toEqual(["spyx", "tslax", "sol"]);
  });

  it("keeps basket order verbatim (seq derives from it — never re-sorted)", () => {
    const parsed = brokerParamsSchema.parse({
      ...VALID,
      basket: [
        { assetId: "sol", pct: 10 },
        { assetId: "spyx", pct: 90 },
      ],
    });
    expect(parsed.basket[0].assetId).toBe("sol");
  });

  it("rejects percentages that do not sum to 100", () => {
    expect(
      brokerParamsSchema.safeParse({
        ...VALID,
        basket: [
          { assetId: "spyx", pct: 60 },
          { assetId: "sol", pct: 30 },
        ],
      }).success,
    ).toBe(false);
  });

  it("enforces the PS-F4.1 $1 minimum and the ≤5-asset contract allowlist", () => {
    expect(brokerParamsSchema.safeParse({ ...VALID, amountUsd: 0.99 }).success).toBe(
      false,
    );
    expect(
      brokerParamsSchema.safeParse({
        ...VALID,
        basket: Array.from({ length: 6 }, (_, i) => ({
          assetId: `a${i}`,
          pct: 100 / 6,
        })),
      }).success,
    ).toBe(false);
  });

  it("requires an ISO-8601 nextRunAt", () => {
    expect(
      brokerParamsSchema.safeParse({ ...VALID, nextRunAt: "next tuesday" }).success,
    ).toBe(false);
  });
});
