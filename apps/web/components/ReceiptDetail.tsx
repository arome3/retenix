"use client";

// C4 expansion (doc 11) — the full forensics behind a receipt row: the fee
// split (gas/service/LP — canonical receipt transparency, PS-10.6), named
// funding sources (the ONE surface where networks are named — G12), the
// universalx verification link (built ONLY via activityUrl over a guarded
// id), the policy link ("because you set: …" → the plan's C3 card), and
// per-leg rows for aggregate receipts (sweeps today; kill legs render here in
// module 13 through the same shape).
//
// Honesty rules (Security & failure modes):
//   - every number here is fees_json/payload passthrough — never computed,
//     never estimated (G8); the displayed split is penny-reconciled to sum to
//     the displayed total (splitFeesForDisplay);
//   - a missing detail degrades to "details are still settling" (PROPOSED
//     copy) — values are never fabricated;
//   - system/blocked rows show NO fee line (absent, not zeroed).
import {
  fmtUsd as receiptUsd,
  splitFeesForDisplay,
  type FeedItem,
  type LegDetail,
} from "@retenix/shared";
import { activityUrl } from "@retenix/ua";
import { Num } from "@/components/Num";
import { legFeeText, legOutcomeLabel, receiptTimestamp } from "@/lib/feed-view";

export interface ReceiptDetailProps {
  item: FeedItem;
  /** DOM id — the row's aria-controls target. */
  detailId: string;
  /** Frozen-while-paused clock (react-hooks/purity — render never reads Date.now()). */
  nowMs: number;
  /** The plan's terms line, e.g. "$25.00 every week" — omitted when the plan
   *  row is gone (revoked-and-recreated plans degrade gracefully). */
  policyQuote?: string;
  /** Opens the plan's C3 card sheet. */
  onOpenPolicy?: () => void;
  /** Modules 06/13 own the retry endpoints — no callback ⇒ no retry chip. */
  onRetryLeg?: (leg: LegDetail) => void;
}

export function ReceiptDetail({
  item,
  detailId,
  nowMs,
  policyQuote,
  onOpenPolicy,
  onRetryLeg,
}: ReceiptDetailProps) {
  const detail = item.detail;
  const split = detail?.fees ? splitFeesForDisplay(detail.fees) : null;
  // An executed receipt should always have its split (fees_json is written at
  // finish time) — its absence means webhook lag, said honestly (PROPOSED copy).
  const settling = item.variant === "executed" && !split;
  const { absolute } = receiptTimestamp(item.at, nowMs);

  return (
    <div
      id={detailId}
      className="mt-1 flex flex-col gap-3 rounded-md bg-muted/40 p-3 text-small"
    >
      {settling && (
        <p className="text-muted-foreground">details are still settling</p>
      )}

      {split && (
        <dl className="grid w-fit min-w-48 grid-cols-[auto_1fr] gap-x-6 gap-y-0.5 text-muted-foreground">
          <dt>gas</dt> {/* copy-canon-allow — receipt fee-split transparency (PS-10.6) */}
          <dd className="text-right">
            <Num>{split.gas}</Num>
          </dd>
          <dt>service</dt>
          <dd className="text-right">
            <Num>{split.service}</Num>
          </dd>
          <dt>LP</dt>
          <dd className="text-right">
            <Num>{split.lp}</Num>
          </dd>
          <dt className="text-foreground">fees</dt>
          <dd className="text-right text-foreground">
            <Num>{split.total}</Num>
          </dd>
        </dl>
      )}

      {detail?.sources && detail.sources.length > 0 && (
        <p className="text-muted-foreground">
          {/* copy-canon-allow — receipts may name networks (G12 provenance) */}
          funded from{" "}
          <span className="text-foreground">{detail.sources.join(" + ")}</span>
        </p>
      )}

      {detail?.legs && detail.legs.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Per-source detail">
          {detail.legs.map((leg, i) => (
            <li
              key={`${leg.network}-${leg.symbol ?? ""}-${i}`} // copy-canon-allow — key expression, and receipts may name networks
              className="flex items-baseline gap-2 text-muted-foreground"
            >
              <span className="text-foreground">
                {leg.network}
                {leg.symbol ? ` · ${leg.symbol}` : ""}
              </span>
              {leg.usd !== undefined && <Num>{receiptUsd(leg.usd)}</Num>}
              <span>{legOutcomeLabel(leg.outcome)}</span>
              {legFeeText(leg) !== null && (
                <Num className="ml-auto">{legFeeText(leg)}</Num>
              )}
              {leg.uaTxId && (
                <a
                  href={activityUrl(leg.uaTxId)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-agent underline-offset-2 hover:underline"
                >
                  view onchain
                </a>
              )}
              {onRetryLeg && leg.outcome === "failed" && (
                <button
                  type="button"
                  onClick={() => onRetryLeg(leg)}
                  className="min-h-6 rounded-full border border-border px-2 text-caption"
                >
                  Retry
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {detail?.uaTxId && (
          <a
            href={activityUrl(detail.uaTxId)}
            target="_blank"
            rel="noreferrer"
            className="text-agent underline-offset-2 hover:underline"
          >
            view onchain
          </a>
        )}
        {policyQuote && onOpenPolicy && (
          <button
            type="button"
            onClick={onOpenPolicy}
            className="min-h-6 text-left text-agent underline-offset-2 hover:underline"
          >
            because you set: <Num>{policyQuote}</Num>
          </button>
        )}
        <span className="ml-auto text-caption text-muted-foreground">
          <Num>{absolute}</Num>
        </span>
      </div>
    </div>
  );
}
