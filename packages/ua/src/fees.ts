// packages/ua/src/fees.ts — the ONLY fee parser in the codebase (doc 03).
//
// Particle returns fee totals as 18-decimal strings on `tx.feeQuotes[0].fees.totals`
// (gotcha G8). Format every field with `formatUnits(x, 18)`; never `Number()` a raw
// string, and never hardcode a fee level — Particle fees are per-project (OQ1 is
// unresolved by design: downstream UI shows whatever this returns, no assumptions).
// Missing fields collapse to 0 so a partial quote never throws in a receipt path.
import { formatUnits } from "ethers";

export interface FeeTotalsUSD {
  gas: number;
  service: number;
  lp: number;
  total: number;
}

export function parseFeeTotals(tx: { feeQuotes?: unknown[] }): FeeTotalsUSD {
  const t =
    (tx.feeQuotes?.[0] as { fees?: { totals?: Record<string, string> } })?.fees
      ?.totals ?? {};
  const f = (x?: string) => (x ? Number(formatUnits(x, 18)) : 0);
  const gas = f(t.gasFeeTokenAmountInUSD),
    service = f(t.transactionServiceFeeTokenAmountInUSD),
    lp = f(t.transactionLPFeeTokenAmountInUSD);
  return { gas, service, lp, total: gas + service + lp };
}
