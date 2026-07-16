/*
 * Feed rendering contract (doc 11) — the shared layer between the stored
 * receipts (worker executions rows + web events rows) and every feed surface:
 * S4 Activity (module 11) and the Home mini-feed (module 12 reuses this file).
 *
 * Two laws govern everything here:
 *   - CONFLICTS #18: the stored `receipt_text` is the single text source. The
 *     compact row applies MECHANICAL ELISIONS only (compactSentence below) —
 *     this module never composes, reorders, or authors money sentences.
 *   - "status is machine truth, receipt_text is display truth" (module 08):
 *     the variant map is a pure function of the execution status; inclusion in
 *     the feed is the `receipt_text <> ''` predicate (in-flight and mid-retry
 *     rows carry the empty string).
 *
 * Framework-free on purpose (imported by web server routers, web client
 * components, and node unit tests alike).
 */
import { fmtUsd, type FeeTotalsUSD } from "./receipts";
import { NETWORK_NAMES, networkName } from "./sweep";

// ---------------------------------------------------------------------------
// Execution status → variant (doc 11 task 1 — total over all seven statuses)
// ---------------------------------------------------------------------------

/** Mirror of packages/db executionStatus enum values (doc 00 §schema). Shared
 *  is a leaf package and cannot import @retenix/db; the unit test golden-pins
 *  these seven so the two lists cannot drift silently (NETWORK_NAMES pattern). */
export const EXECUTION_STATUSES = [
  "quoted",
  "recorded",
  "submitted",
  "finished",
  "refunded",
  "blocked",
  "failed",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export type FeedVariant = "executed" | "blocked" | "failed-refunded" | "system";

/** plans.kind values; "legacy" renders the Continuity mark (doc 01 avatars). */
export type FeedAgent = "broker" | "guardian" | "legacy";

/**
 * finished → executed · blocked → blocked · refunded/failed → failed-refunded.
 * Non-terminal statuses (quoted/recorded/submitted) return null — they never
 * appear in the feed (their rows carry receipt_text = "" anyway; doc 11).
 *
 * Note (flagged for W3 review, HANDOFF): BP-skip and still-settling receipts
 * live on status `failed`/`refunded` rows (module 08 — the enum has no
 * "skipped"), so they classify as failed-refunded here even though doc 11's
 * variant prose lists "skips" under system. Honoring that prose would require
 * sniffing the sentence text, which "status is machine truth" forbids.
 */
export function executionVariant(status: ExecutionStatus): FeedVariant | null {
  switch (status) {
    case "finished":
      return "executed";
    case "blocked":
      return "blocked";
    case "refunded":
    case "failed":
      return "failed-refunded";
    case "quoted":
    case "recorded":
    case "submitted":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Event feed allowlist (doc 11) — the ONLY events.type values that are feed
// rows. Everything else (execution.* metadata twins, sweep.authorized,
// sig.nonce, intent.parsed, plan.autonomy_set, compliance.*, job.*, …) is an
// audit row and must never render as a receipt.
// ---------------------------------------------------------------------------

/** kill.leg/kill.receipt are module 13's rows (per-leg receipts + the ONE
 *  aggregate, doc 13); estate.checkin is module 14's forward contract. All
 *  carry a display-ready `receipt` string — in-flight kill legs deliberately
 *  lack it and are skipped until terminal. sell.receipt is doc 12's
 *  flag-gated sell-from-detail (same rule). */
export const FEED_EVENT_TYPES = [
  "plan.activated",
  "plan.revoked",
  "plan.paused",
  "plan.resumed",
  "sweep.receipt",
  "sell.receipt",
  "kill.leg",
  "kill.receipt",
  "estate.checkin",
] as const;
export type FeedEventType = (typeof FEED_EVENT_TYPES)[number];

export function eventVariant(type: string): "system" | null {
  return (FEED_EVENT_TYPES as readonly string[]).includes(type) ? "system" : null;
}

/**
 * The display-ready sentence stored on the event row: sweep receipts carry it
 * at payload.headline (module 06), plan lifecycle (and future kill/estate)
 * rows at payload.receipt (module 10). Missing/non-string → null: the router
 * SKIPS the row rather than fabricating text (Security & failure modes).
 */
export function eventSentence(type: string, payload: unknown): string | null {
  const rec = payload as Record<string, unknown> | null | undefined;
  const field = type === "sweep.receipt" ? rec?.headline : rec?.receipt;
  return typeof field === "string" && field.length > 0 ? field : null;
}

/** plans.kind carried on plan.* payloads → FeedAgent (null when absent). */
export function feedAgentFrom(kind: unknown): FeedAgent | null {
  return kind === "broker" || kind === "guardian" || kind === "legacy"
    ? kind
    : null;
}

// ---------------------------------------------------------------------------
// The wire item (tech spec §13 activity.feed contract)
// ---------------------------------------------------------------------------

/** One leg of an aggregate receipt (sweep today; kill legs in module 13).
 *  Generic on purpose — modules 13/14 render through this shape. */
export interface LegDetail {
  /** Display network name — receipts may name networks (doc 01 exceptions). */
  network: string;
  symbol?: string;
  usd?: number;
  /** finished | refunded | failed | unverified (sweep set); open for 13/14. */
  outcome: string;
  serverVerified?: boolean;
  fees?: FeeTotalsUSD;
  feeSource?: "settled" | "quoted" | "none";
  /** Present only when it passed isUaTxIdFormat — safe for activityUrl(). */
  uaTxId?: string;
  error?: string;
}

export interface FeedDetail {
  /** From executions.fees_json (parseFeeTotals output) — absent, not zeroed,
   *  when the row has none (system/blocked rows, webhook lag). */
  fees?: FeeTotalsUSD;
  /** Named funding sources — expansion only (G12). */
  sources?: string[];
  /** Present only when it passed isUaTxIdFormat — safe for activityUrl(). */
  uaTxId?: string;
  /** The plan behind this action — the "because you set: …" C3 link target. */
  planId?: string;
  /** Aggregate receipts (sweep/kill) — per-leg forensics. */
  legs?: LegDetail[];
}

export interface FeedItem {
  /** Source-prefixed ("ex_"/"ev_" + uuid) — unique across the union. */
  id: string;
  /** ISO timestamp (no tRPC transformer — Dates don't survive the wire). */
  at: string;
  variant: FeedVariant;
  /** The stored receipt sentence, byte-verbatim (CONFLICTS #18). */
  sentence: string;
  /** Plan kind behind the action; null for non-plan system rows (sweeps). */
  agent: FeedAgent | null;
  detail?: FeedDetail;
}

// ---------------------------------------------------------------------------
// Compact row transform (C4 / CONFLICTS #18 / G12) — mechanical elisions ONLY
// ---------------------------------------------------------------------------

// The canonical executed sentence's fee parenthetical and link tail (doc 08).
const FEE_PARENTHETICAL_RE =
  / \(gas \$[\d,.]+, service \$[\d,.]+, LP \$[\d,.]+\)/; // copy-canon-allow (receipt transform)
const VIEW_ONCHAIN_TAIL_RE = / · view onchain$/;
const FUNDED_FROM_PREFIX = "funded from ";
const FALLBACK_SOURCE_RE = /^Source \d+$/; // networkName()'s unknown-id form

const KNOWN_NETWORK_NAMES: ReadonlySet<string> = new Set(
  Object.values(NETWORK_NAMES),
);

/**
 * The C4 compact form of a stored sentence — three mechanical elisions, never
 * composition (CONFLICTS #18):
 *   1. the fee-split parenthetical is elided (the expansion always shows it);
 *   2. the trailing "· view onchain" is elided (the expansion holds the link);
 *   3. "funded from Base + Arbitrum" → "▲ funded from 2 sources" (G12: the
 *      word "sources" stays in compact rows; the ▲ is decorative direction,
 *      not a delta — G14) — applied ONLY when every listed name is a known
 *      network name, so the "funded from your balance" fallback sentence
 *      passes through verbatim.
 * Every other sentence (blocked/refunded/skipped/system) is untouched. The
 * FULL stored sentence remains the row's accessible name (DS-10.8).
 */
export function compactSentence(sentence: string): string {
  const stripped = sentence
    .replace(FEE_PARENTHETICAL_RE, "")
    .replace(VIEW_ONCHAIN_TAIL_RE, "");
  const segments = stripped.split(" · ");
  const i = segments.findIndex((s) => s.startsWith(FUNDED_FROM_PREFIX));
  if (i === -1) return stripped;
  const names = segments[i].slice(FUNDED_FROM_PREFIX.length).split(" + ");
  const allKnown =
    names.length > 0 &&
    names.every(
      (n) => KNOWN_NETWORK_NAMES.has(n) || FALLBACK_SOURCE_RE.test(n),
    );
  if (!allKnown) return stripped;
  const noun = names.length === 1 ? "source" : "sources";
  segments[i] = `▲ funded from ${names.length} ${noun}`;
  return segments.join(" · ");
}

// ---------------------------------------------------------------------------
// Fee-split display (PS-10.6) — the split must SUM to the displayed total
// ---------------------------------------------------------------------------

export interface FeeSplitDisplay {
  gas: string; // copy-canon-allow (receipt-transparency labels, not decision copy)
  service: string;
  lp: string;
  total: string;
}

/**
 * Formats a fee split so the displayed parts sum EXACTLY to the displayed
 * total (DoD rounding edge: gas/service/lp = $0.045 each, total $0.135 →
 * total displays $0.14 and naive per-part rounding would show $0.15 worth of
 * parts). Display pennies are allocated by largest remainder; every displayed
 * part is within half a cent of its fees_json value — reconciled presentation
 * of stored numbers, never invented ones (G8).
 */
export function splitFeesForDisplay(fees: FeeTotalsUSD): FeeSplitDisplay {
  const parts = [fees.gas, fees.service, fees.lp];
  if (!parts.every(Number.isFinite) || !Number.isFinite(fees.total)) {
    // Defensive only — fees_json is zod-validated upstream. Never NaN output.
    const f = (v: number) => fmtUsd(Number.isFinite(v) ? v : 0);
    return { gas: f(fees.gas), service: f(fees.service), lp: f(fees.lp), total: f(fees.total) };
  }
  const totalCents = Math.max(0, Math.round(fees.total * 100));
  const rawCents = parts.map((v) => Math.max(0, v * 100));
  const cents = rawCents.map(Math.floor);
  let remaining = totalCents - cents.reduce((a, b) => a + b, 0);
  const byRemainder = rawCents
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remaining > 0 && byRemainder.length > 0; k++) {
    cents[byRemainder[k % byRemainder.length].i] += 1;
    remaining -= 1;
  }
  return {
    gas: fmtUsd(cents[0] / 100),
    service: fmtUsd(cents[1] / 100),
    lp: fmtUsd(cents[2] / 100),
    total: fmtUsd(totalCents / 100),
  };
}

// ---------------------------------------------------------------------------
// universalx link guard (Security & failure modes) — never build an external
// link from an unvalidated string
// ---------------------------------------------------------------------------

/** Conservative URL-path-safe shape for a Particle transactionId. PROPOSED —
 *  tighten once the real id format is frozen (doc 03 OQ5 introspection). */
const UA_TX_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function isUaTxIdFormat(id: unknown): id is string {
  return typeof id === "string" && UA_TX_ID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Funding sources — relocated VERBATIM from apps/worker/src/executor.ts
// (module 11; basket.ts precedent) so the activity router derives the
// expansion's named sources from the same tolerant extractor that baked them
// into receipt_text. UA payload shapes are unfrozen — tolerant extraction.
// ---------------------------------------------------------------------------

export function extractFundingSources(detail: unknown, quote: unknown): string[] {
  for (const payload of [detail, quote]) {
    const deposits = (payload as { depositTokens?: unknown[] } | undefined)
      ?.depositTokens;
    if (Array.isArray(deposits) && deposits.length > 0) {
      const names = uniqueChains(deposits);
      if (names.length > 0) return names;
    }
  }
  // Fallback: the quote's per-chain userOps (funding legs).
  const ops = (quote as { userOps?: unknown[] } | undefined)?.userOps;
  if (Array.isArray(ops)) return uniqueChains(ops);
  return [];
}

function uniqueChains(items: unknown[]): string[] {
  const names: string[] = [];
  for (const item of items) {
    const rec = item as { chainId?: unknown; token?: { chainId?: unknown } };
    const chainId =
      typeof rec.chainId === "number" ? rec.chainId : rec.token?.chainId;
    if (typeof chainId !== "number") continue;
    const name = networkName(chainId);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Sweep legs → LegDetail[] (module 06's SweepReceipt payload)
// ---------------------------------------------------------------------------

/**
 * Maps a sweep.receipt payload's legs to the generic LegDetail shape. Leg
 * transaction ids are re-guarded here; the stored activityUrl string on the
 * payload is deliberately ignored — links are rebuilt from guarded ids only.
 * Malformed legs are skipped, never invented.
 */
export function sweepLegsToDetail(payload: unknown): LegDetail[] {
  const legs = (payload as { legs?: unknown[] } | null | undefined)?.legs;
  if (!Array.isArray(legs)) return [];
  const out: LegDetail[] = [];
  for (const raw of legs) {
    const leg = raw as Record<string, unknown>;
    if (typeof leg?.network !== "string" || typeof leg?.outcome !== "string") {
      continue;
    }
    const fees = leg.fees as FeeTotalsUSD | undefined;
    const feesValid =
      fees !== undefined &&
      typeof fees === "object" &&
      fees !== null &&
      [fees.gas, fees.service, fees.lp, fees.total].every(
        (v) => typeof v === "number" && Number.isFinite(v),
      );
    const feeSource = leg.feeSource;
    out.push({
      network: leg.network,
      symbol: typeof leg.symbol === "string" ? leg.symbol : undefined,
      usd: typeof leg.usd === "number" ? leg.usd : undefined,
      outcome: leg.outcome,
      serverVerified:
        typeof leg.serverVerified === "boolean" ? leg.serverVerified : undefined,
      fees: feesValid ? fees : undefined,
      feeSource:
        feeSource === "settled" || feeSource === "quoted" || feeSource === "none"
          ? feeSource
          : undefined,
      uaTxId: isUaTxIdFormat(leg.transactionId) ? leg.transactionId : undefined,
      error: typeof leg.error === "string" ? leg.error : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Day dividers (S4 — client-computed; DS-9.4 register)
// ---------------------------------------------------------------------------

const DIVIDER_FMT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
});

/** Local-calendar day key — never derived by subtracting 24h (DST-safe). */
function localDayParts(ms: number): { y: number; m: number; d: number } {
  const dt = new Date(ms);
  return { y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate() };
}

const sameDay = (
  a: { y: number; m: number; d: number },
  b: { y: number; m: number; d: number },
) => a.y === b.y && a.m === b.m && a.d === b.d;

/** "Today" / "Yesterday" / "July 24" (+", 2025" when the year differs). */
export function dayLabel(atIso: string, nowMs: number): string {
  const atMs = Date.parse(atIso);
  const at = localDayParts(atMs);
  const now = localDayParts(nowMs);
  if (sameDay(at, now)) return "Today";
  const yesterday = new Date(now.y, now.m, now.d - 1);
  if (sameDay(at, localDayParts(yesterday.getTime()))) return "Yesterday";
  const label = DIVIDER_FMT.format(new Date(atMs));
  return at.y === now.y ? label : `${label}, ${at.y}`;
}

export type FeedRow =
  | { kind: "divider"; key: string; label: string }
  | { kind: "receipt"; key: string; item: FeedItem };

/**
 * Flattens (already time-desc) items into the S4 row model: a divider before
 * each day's first receipt. Dedupes by item id (insurance against page-
 * boundary races under head-prepends). nowMs comes from the feed's shared
 * clock so "Today"/"Yesterday" freeze together with relative times on pause.
 */
export function buildFeedRows(items: FeedItem[], nowMs: number): FeedRow[] {
  const rows: FeedRow[] = [];
  const seen = new Set<string>();
  let prevDay: { y: number; m: number; d: number } | null = null;
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const day = localDayParts(Date.parse(item.at));
    if (prevDay === null || !sameDay(day, prevDay)) {
      rows.push({
        kind: "divider",
        key: `d:${day.y}-${day.m + 1}-${day.d}`,
        label: dayLabel(item.at, nowMs),
      });
      prevDay = day;
    }
    rows.push({ kind: "receipt", key: item.id, item });
  }
  return rows;
}
