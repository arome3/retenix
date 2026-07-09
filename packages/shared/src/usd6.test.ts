import { describe, expect, it } from "vitest";
import { USD6, fromUsd6, toUsd6 } from "./usd6";

describe("usd6", () => {
  it("encodes the canonical example: $15.00 === 15_000_000n", () => {
    expect(toUsd6(15)).toBe(15_000_000n);
    expect(toUsd6(15)).toBe(15n * USD6);
  });

  it("round-trips whole dollars and cents", () => {
    expect(fromUsd6(toUsd6(15))).toBe(15);
    expect(fromUsd6(toUsd6(1234.56))).toBe(1234.56);
    expect(fromUsd6(15_000_000n)).toBe(15);
  });

  it("rounds binary float dust to the nearest micro-USD", () => {
    expect(toUsd6(19.99)).toBe(19_990_000n);
    expect(toUsd6(0.1 + 0.2)).toBe(300_000n);
  });
});
