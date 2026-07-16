import { describe, expect, it } from "vitest";
import {
  holdingAriaLabel,
  holdingDeltaClass,
  holdingDeltaText,
} from "./portfolio-view";

describe("holdingDeltaText — the fmtDelta hookup (doc 12 DoD)", () => {
  it("routes deltaUsd/deltaPct through fmtDelta verbatim", () => {
    expect(holdingDeltaText({ deltaUsd: 12.4, deltaPct: 2.15 })).toBe(
      "▲ +$12.40 (+2.15%)",
    );
    expect(holdingDeltaText({ deltaUsd: -3.2, deltaPct: -0.85 })).toBe(
      "▼ −$3.20 (−0.85%)", // U+2212, glyphs are text (DS-5.2)
    );
  });

  it("null basis → null (row prints —, never a guessed return)", () => {
    expect(holdingDeltaText({ deltaUsd: null, deltaPct: null })).toBeNull();
    expect(holdingDeltaText({ deltaUsd: 5, deltaPct: null })).toBeNull();
  });
});

describe("holdingDeltaClass — G14's only gain/loss surface", () => {
  it("positive/zero → text-positive, negative → text-negative", () => {
    expect(holdingDeltaClass({ deltaUsd: 1, deltaPct: 1 })).toBe("text-positive");
    expect(holdingDeltaClass({ deltaUsd: 0, deltaPct: 0 })).toBe("text-positive");
    expect(holdingDeltaClass({ deltaUsd: -1, deltaPct: -1 })).toBe("text-negative");
  });
});

describe("holdingAriaLabel — full-sentence row names", () => {
  const base = {
    ticker: "SPYx",
    name: "S&P 500 (tokenized)",
    valueUsd: 30,
    markStale: false,
  };

  it("carries the rendered value and a worded delta", () => {
    expect(
      holdingAriaLabel({ ...base, deltaUsd: 0.63, deltaPct: 4.17 }),
    ).toBe(
      "SPYx, S&P 500 (tokenized) — worth $30.00, up $0.63 (4.17%) since purchase. Opens details.",
    );
    expect(
      holdingAriaLabel({ ...base, deltaUsd: -0.63, deltaPct: -2.06 }),
    ).toContain("down $0.63 (2.06%) since purchase");
  });

  it("says so plainly when return is unknowable or the price is stale", () => {
    expect(
      holdingAriaLabel({ ...base, deltaUsd: null, deltaPct: null }),
    ).toContain("return unavailable");
    expect(
      holdingAriaLabel({
        ...base,
        deltaUsd: null,
        deltaPct: null,
        markStale: true,
      }),
    ).toContain("price may be out of date");
  });
});
