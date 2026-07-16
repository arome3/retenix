// Sell-from-detail (doc 12, PROPOSED — sell scope is a product-owner
// decision; sell-all only, behind the NEXT_PUBLIC_PORTFOLIO_LIVE flag).
// Schemas live here so the client-signed bytes can never drift from server
// validation (the sweep.ts discipline).

import { z } from "zod";

export const SELL_RECEIPT_EVENT = "sell.receipt";

/** The signed portfolio.recordSell payload. The client CLAIMS only the
 *  transactionId + which asset it sold; every displayed/ledgered fact
 *  (outcome, qty, usd) is re-derived server-side from the polled UA payload
 *  — a compromised client can't launder numbers through this route. */
export const sellRecordPayloadSchema = z.object({
  assetId: z.string().min(1).max(40),
  transactionId: z.string().min(1).max(200),
});
export type SellRecordPayload = z.infer<typeof sellRecordPayloadSchema>;

/** Number-free by design: a single-phase report can't server-pin a USD
 *  headline the way sweep's authorize-scan does, so the sentence states only
 *  what the server verified. The detail carries the onchain link. */
export function sellReceiptText(ticker: string): string {
  return `Sold ${ticker} — proceeds added to your buying power.`;
}
