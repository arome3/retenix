"use client";

// C4 · ReceiptRow (doc 11; DS §7) — one plain-English sentence per action, in
// the agent's voice, expandable to full forensics. The visible sentence is the
// stored receipt text after the sanctioned mechanical elisions ONLY
// (compactSentence — CONFLICTS #18): this component never composes money
// sentences; the DB row is the audit record.
//
//   [mark 32px]  [compact sentence — font-sans 400]  [relative time · .tnum]
//
// - Blocked receipts render PROUDLY: amber shield, same size and register as
//   executed rows — they are the product working, not an error state (G14:
//   --warning, never the loss red; G15: nothing celebrates).
// - The whole row is the expander (≥24px target, aria-expanded/controls;
//   ConfirmSheet's disclosure pattern) and the tooltip trigger: keyboard focus
//   surfaces the ALWAYS-absolute time (DS-9.4) via Radix Tooltip; the <time>
//   also carries title= for pointer hover, and the expansion repeats the
//   absolute time in plain text.
// - New arrivals slide in via --animate-receipt-in (250ms) on an INNER
//   wrapper — the outer <li> is transform-positioned by the virtualizer, and
//   a keyframe animating `transform` on it would teleport the row. Reduced
//   motion opts into the 120ms opacity fade (data-rm-fade + data-state).
import { compactSentence, type FeedItem, type LegDetail } from "@retenix/shared";
import { Shield } from "lucide-react";
import {
  BrokerAvatar,
  ContinuityAvatar,
  GuardianAvatar,
} from "@/components/avatars";
import { Num } from "@/components/Num";
import { ReceiptDetail } from "@/components/ReceiptDetail";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { receiptMark, receiptTimestamp } from "@/lib/feed-view";

const AVATAR = {
  broker: BrokerAvatar,
  guardian: GuardianAvatar,
  legacy: ContinuityAvatar,
} as const;

export interface ReceiptRowProps {
  item: FeedItem;
  /** Frozen-while-paused clock — relative times stop with the feed (2.2.2). */
  nowMs: number;
  /** Arrival flag (time-bounded by useFeed) — drives the slide-in once. */
  isNew?: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** The plan's terms line for "because you set: …" (absent → link omitted). */
  policyQuote?: string;
  onOpenPolicy?: () => void;
  /** Modules 06/13 own retry endpoints — no callback ⇒ no retry chip. */
  onRetryLeg?: (leg: LegDetail) => void;
}

function Mark({ item }: { item: FeedItem }) {
  const mark = receiptMark(item.variant, item.agent);
  if (mark.type === "shield") {
    return (
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-warning/40 text-warning"
      >
        <Shield size={20} strokeWidth={1.5} />
      </span>
    );
  }
  if (mark.type === "avatar") {
    const Avatar = AVATAR[mark.agent];
    return (
      <span
        aria-hidden="true"
        className={`shrink-0 ${mark.muted ? "opacity-60" : ""}`}
      >
        <Avatar size={32} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center"
    >
      <span className="size-2 rounded-full bg-muted-foreground/60" />
    </span>
  );
}

export function ReceiptRow({
  item,
  nowMs,
  isNew = false,
  expanded,
  onToggle,
  policyQuote,
  onOpenPolicy,
  onRetryLeg,
}: ReceiptRowProps) {
  const detailId = `receipt-detail-${item.id}`;
  const { relative, absolute } = receiptTimestamp(item.at, nowMs);

  return (
    <div
      className={isNew ? "animate-receipt-in" : undefined}
      data-rm-fade={isNew ? "" : undefined}
      data-state={isNew ? "open" : undefined}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={onToggle}
            className="flex min-h-6 w-full items-start gap-3 rounded-lg py-3 text-left"
          >
            <Mark item={item} />
            <span className="min-w-0 flex-1 text-body font-normal text-foreground">
              {compactSentence(item.sentence)}
            </span>
            <time
              dateTime={item.at}
              title={absolute}
              className="shrink-0 pt-0.5 text-right text-caption text-muted-foreground"
            >
              <Num>{relative}</Num>
            </time>
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" align="start">
          <Num>{absolute}</Num>
        </TooltipContent>
      </Tooltip>
      {expanded && (
        <ReceiptDetail
          item={item}
          detailId={detailId}
          nowMs={nowMs}
          policyQuote={policyQuote}
          onOpenPolicy={onOpenPolicy}
          onRetryLeg={onRetryLeg}
        />
      )}
    </div>
  );
}
