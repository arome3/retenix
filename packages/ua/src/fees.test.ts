import { describe, expect, it } from "vitest";
import { parseFeeTotals } from "./fees";

// Fee totals arrive as 18-decimal strings (G8). 0.03 → "30000000000000000", etc.
const usd = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();

/** Build a tx-shaped fixture with the given totals fields (any omitted). */
function quote(totals: Record<string, string>) {
  return { feeQuotes: [{ fees: { totals } }] };
}

describe("parseFeeTotals", () => {
  it("parses 18-decimal strings into USD numbers and sums the total", () => {
    // The tech spec §7 canonical receipt: fees $0.14 (gas $0.03, service $0.08, LP $0.03).
    const tx = quote({
      gasFeeTokenAmountInUSD: usd(0.03),
      transactionServiceFeeTokenAmountInUSD: usd(0.08),
      transactionLPFeeTokenAmountInUSD: usd(0.03),
    });
    const f = parseFeeTotals(tx);
    expect(f.gas).toBeCloseTo(0.03, 12);
    expect(f.service).toBeCloseTo(0.08, 12);
    expect(f.lp).toBeCloseTo(0.03, 12);
    expect(f.total).toBeCloseTo(0.14, 12);
  });

  it("treats explicit zero strings as 0 (not NaN)", () => {
    const f = parseFeeTotals(
      quote({
        gasFeeTokenAmountInUSD: "0",
        transactionServiceFeeTokenAmountInUSD: "0",
        transactionLPFeeTokenAmountInUSD: "0",
      }),
    );
    expect(f).toEqual({ gas: 0, service: 0, lp: 0, total: 0 });
  });

  it("defaults missing fields to 0 (partial quote never throws)", () => {
    // Only the service fee is present; gas and LP are absent.
    const f = parseFeeTotals(
      quote({ transactionServiceFeeTokenAmountInUSD: usd(0.05) }),
    );
    expect(f.gas).toBe(0);
    expect(f.lp).toBe(0);
    expect(f.service).toBeCloseTo(0.05, 12);
    expect(f.total).toBeCloseTo(0.05, 12);
  });

  it("returns all zeros when totals is empty", () => {
    expect(parseFeeTotals(quote({}))).toEqual({
      gas: 0,
      service: 0,
      lp: 0,
      total: 0,
    });
  });

  it("returns all zeros when feeQuotes is empty or absent", () => {
    expect(parseFeeTotals({ feeQuotes: [] })).toEqual({
      gas: 0,
      service: 0,
      lp: 0,
      total: 0,
    });
    expect(parseFeeTotals({})).toEqual({
      gas: 0,
      service: 0,
      lp: 0,
      total: 0,
    });
  });

  it("reads only feeQuotes[0] (ignores later quotes)", () => {
    const tx = {
      feeQuotes: [
        { fees: { totals: { gasFeeTokenAmountInUSD: usd(0.01) } } },
        { fees: { totals: { gasFeeTokenAmountInUSD: usd(9.99) } } },
      ],
    };
    expect(parseFeeTotals(tx).gas).toBeCloseTo(0.01, 12);
  });
});
