// Portfolio statement math (doc 12, PROPOSED mechanics — the spec fixes the
// requirements, not the formulas; product-owner review by W3). Pure and
// framework-free: callers inject fills, balances, marks and asset metadata —
// no db/registry/fetch imports here (packages/shared is a leaf).
//
// Honesty rules this module enforces (doc 12 §Security & failure modes):
//   - average-cost basis; sells reduce basis proportionally;
//   - a buy whose filled qty is unknowable POISONS that asset's basis —
//     basis renders "—" and return is omitted, never guessed;
//   - marks are display-only; nothing here prices an execution.

export const SOL_NATIVE_MINT = "So11111111111111111111111111111111111111112";

/** Chain-vs-ledger qty drift tolerated before basis is declared unknown.
 *  Covers uiAmount rounding plus fill-vs-quote slippage (tradeConfig pins
 *  slippage at 100 bps, so 2% is a safe display-grade envelope). */
export const BASIS_QTY_TOLERANCE = 0.02;

/** Below this, a position is dust-of-dust and does not exist to the statement. */
export const QTY_EPSILON = 1e-9;

/** PROPOSED (doc 12) — per-user holdings cache TTL, the account-summary
 *  precedent (packages/shared sweep.ts ACCOUNT_SUMMARY_CACHE_TTL_MS). */
export const PORTFOLIO_HOLDINGS_CACHE_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The registry slice this module needs — callers pass REGISTRY entries. */
export interface PortfolioAssetMeta {
  id: string;
  ticker: string;
  name: string;
  kind: "equity" | "crypto";
  chainId: number;
  address: string;
  disclosure?: string;
}

/** One executed trade, normalized from executions (buys) or events (sells). */
export interface Fill {
  side: "buy" | "sell";
  assetId: string;
  /** USD notional. Required for buys (feeds basis); informational on sells. */
  usd: number | null;
  /** Filled quantity in human units; null = unknowable (poisons basis). */
  qty: number | null;
  /** ISO timestamp — fills are folded in chronological order. */
  at: string;
}

export interface BasisEntry {
  /** Net ledger quantity (buys − sells), clamped at 0. */
  qty: number;
  /** Remaining average-cost basis for the net quantity. */
  costBasisUsd: number;
  /** costBasisUsd / qty; null when qty ≈ 0. */
  avgCostUsd: number | null;
  /** False the moment any fill for this asset had unknown qty/usd. */
  basisKnown: boolean;
}

export interface PositionInput {
  assetId: string;
  qty: number;
  /** Exact human string (e.g. RPC uiAmountString) — survives to sell-all. */
  qtyHuman?: string;
}

export interface MarkValue {
  usd: number;
  stale: boolean;
  source: "jupiter" | "last-trade";
}

/** Doc-12 Holding contract + documented extensions (null = "—"/omitted;
 *  markStale drives the doc-01 stale marker; spark filled from snapshots). */
export interface PortfolioHolding {
  assetId: string;
  ticker: string;
  name: string;
  qty: number;
  qtyHuman?: string;
  markUsd: number;
  markStale: boolean;
  valueUsd: number;
  costBasisUsd: number | null;
  deltaUsd: number | null;
  deltaPct: number | null;
  spark: number[];
  disclosure?: string;
}

export interface PortfolioTotals {
  totalUsd: number;
  /** Sum over rows with known basis only. */
  costBasisUsd: number;
  returnUsd: number | null;
  returnPct: number | null;
}

// ---------------------------------------------------------------------------
// Fill attribution helpers
// ---------------------------------------------------------------------------

/**
 * Seq index from a jobs.period_key (`${planId}:${periodStartIso}:${seq}`).
 * The ISO segment contains colons, so only the LAST segment counts, and it
 * must be a pure integer — rogue keys (`:rogue:${uuid}`) and e2e keys
 * (`:e2e:${uuid}`) end in a uuid and return null.
 */
export function parseSeqFromPeriodKey(periodKey: string): number | null {
  const tail = periodKey.slice(periodKey.lastIndexOf(":") + 1);
  if (!/^\d{1,3}$/.test(tail)) return null;
  return Number(tail);
}

/** Address candidates that count as "this asset" in UA token payloads.
 *  SOL's registry address is the EVM zero sentinel; UA payloads carry the
 *  native mint, so both are accepted. */
export function acceptableAddresses(asset: {
  id: string;
  address: string;
}): string[] {
  const out = [asset.address];
  if (asset.id === "sol") out.push(SOL_NATIVE_MINT);
  return out;
}

/** EVM hex compares case-insensitively; Solana base58 is case-sensitive. */
function matchesAddress(candidate: string, accept: readonly string[]): boolean {
  for (const a of accept) {
    if (candidate === a) return true;
    if (
      candidate.startsWith("0x") &&
      a.startsWith("0x") &&
      candidate.toLowerCase() === a.toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}

interface TokenAmountLike {
  token?: { address?: unknown };
  amount?: unknown;
}

function qtyFromEntry(
  entry: TokenAmountLike,
  accept: readonly string[],
): number | null {
  const address = entry.token?.address;
  if (typeof address !== "string" || !matchesAddress(address, accept)) {
    return null;
  }
  // ITokenWithUSD.amount is a human-unit decimal string (SDK 2.0.3 typings);
  // shape is OQ5-unfrozen, so anything non-finite or non-positive is treated
  // as unknowable rather than guessed at.
  const qty =
    typeof entry.amount === "string"
      ? Number(entry.amount)
      : typeof entry.amount === "number"
        ? entry.amount
        : Number.NaN;
  return Number.isFinite(qty) && qty > 0 ? qty : null;
}

/**
 * Filled quantity of the asset received in a UA transaction, read from
 * `tokenChanges.incr[]` (then `swaps[].toToken`) of whichever payload knows
 * it — callers pass [uaDetail, quote] so the settled detail wins over the
 * create-time expectation. Tolerant by design: any unrecognized shape is
 * null ("basis unknown"), never a guess.
 */
export function extractFillQty(
  payloads: readonly unknown[],
  accept: readonly string[],
): number | null {
  for (const payload of payloads) {
    if (payload === null || typeof payload !== "object") continue;
    const changes = (payload as { tokenChanges?: unknown }).tokenChanges;
    if (changes === null || typeof changes !== "object") continue;

    const incr = (changes as { incr?: unknown }).incr;
    if (Array.isArray(incr)) {
      for (const entry of incr) {
        const qty = qtyFromEntry(entry as TokenAmountLike, accept);
        if (qty !== null) return qty;
      }
    }
    const swaps = (changes as { swaps?: unknown }).swaps;
    if (Array.isArray(swaps)) {
      for (const swap of swaps) {
        const to = (swap as { toToken?: TokenAmountLike }).toToken;
        if (to === null || typeof to !== "object") continue;
        const qty = qtyFromEntry(to, accept);
        if (qty !== null) return qty;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Average-cost basis ledger
// ---------------------------------------------------------------------------

/**
 * Folds fills (chronological) into per-asset average-cost state. Sells reduce
 * qty and basis proportionally — the statement-register method the spec
 * names. Any fill with unknown qty (or a buy with unknown usd) marks the
 * asset's basis unknown for good: proportionality can't be reconstructed, and
 * the doc's rule is "never guess".
 */
export function buildBasisLedger(fills: readonly Fill[]): Map<string, BasisEntry> {
  const sorted = [...fills].sort((a, b) => a.at.localeCompare(b.at));
  const ledger = new Map<string, { qty: number; cost: number; known: boolean }>();

  for (const fill of sorted) {
    let state = ledger.get(fill.assetId);
    if (!state) {
      state = { qty: 0, cost: 0, known: true };
      ledger.set(fill.assetId, state);
    }

    if (fill.qty === null || (fill.side === "buy" && fill.usd === null)) {
      state.known = false;
      continue;
    }

    if (fill.side === "buy") {
      state.qty += fill.qty;
      state.cost += fill.usd as number;
    } else {
      if (state.qty <= QTY_EPSILON) {
        // Selling what the ledger never saw bought — external in, unknowable.
        state.known = false;
        continue;
      }
      const proportion = Math.min(fill.qty / state.qty, 1);
      state.cost -= state.cost * proportion;
      state.qty = Math.max(state.qty - fill.qty, 0);
    }
  }

  const out = new Map<string, BasisEntry>();
  for (const [assetId, s] of ledger) {
    out.set(assetId, {
      qty: s.qty,
      costBasisUsd: s.cost,
      avgCostUsd: s.qty > QTY_EPSILON ? s.cost / s.qty : null,
      basisKnown: s.known,
    });
  }
  return out;
}

/** Most recent fill price per asset (usd/qty) — the marks-adapter fallback. */
export function lastTradeMarks(fills: readonly Fill[]): Map<string, number> {
  const sorted = [...fills].sort((a, b) => a.at.localeCompare(b.at));
  const out = new Map<string, number>();
  for (const fill of sorted) {
    if (fill.qty !== null && fill.usd !== null && fill.qty > QTY_EPSILON && fill.usd > 0) {
      out.set(fill.assetId, fill.usd / fill.qty);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Holdings assembly
// ---------------------------------------------------------------------------

export interface AssembleInput {
  positions: readonly PositionInput[];
  basis: ReadonlyMap<string, BasisEntry>;
  marks: ReadonlyMap<string, MarkValue>;
  assets: readonly PortfolioAssetMeta[];
}

/**
 * Positions × marks × basis → the doc-12 response rows, sorted by value
 * descending (ring segments and list share this order). A position whose
 * chain qty disagrees with the ledger beyond BASIS_QTY_TOLERANCE was touched
 * outside the plans Retenix saw → basis "—". A position with no mark at all
 * (no live price AND no last trade) is omitted — a number we cannot state
 * beats a number we made up.
 */
export function assembleHoldings(input: AssembleInput): {
  holdings: PortfolioHolding[];
  totals: PortfolioTotals;
} {
  const holdings: PortfolioHolding[] = [];

  for (const position of input.positions) {
    if (position.qty <= QTY_EPSILON) continue;
    const meta = input.assets.find((a) => a.id === position.assetId);
    const mark = input.marks.get(position.assetId);
    if (!meta || !mark) continue;

    const entry = input.basis.get(position.assetId);
    const qtyAgrees =
      entry !== undefined &&
      entry.qty > QTY_EPSILON &&
      Math.abs(entry.qty - position.qty) / Math.max(entry.qty, position.qty) <=
        BASIS_QTY_TOLERANCE;
    const basisKnown = entry !== undefined && entry.basisKnown && qtyAgrees;

    const valueUsd = position.qty * mark.usd;
    const costBasisUsd = basisKnown ? entry.costBasisUsd : null;
    const deltaUsd = costBasisUsd !== null ? valueUsd - costBasisUsd : null;
    const deltaPct =
      costBasisUsd !== null && costBasisUsd > 0
        ? ((valueUsd - costBasisUsd) / costBasisUsd) * 100
        : null;

    holdings.push({
      assetId: meta.id,
      ticker: meta.ticker,
      name: meta.name,
      qty: position.qty,
      qtyHuman: position.qtyHuman,
      markUsd: mark.usd,
      markStale: mark.stale,
      valueUsd,
      costBasisUsd,
      deltaUsd,
      deltaPct,
      spark: [],
      disclosure: meta.disclosure,
    });
  }

  holdings.sort((a, b) => b.valueUsd - a.valueUsd);

  const totalUsd = holdings.reduce((s, h) => s + h.valueUsd, 0);
  const knownRows = holdings.filter((h) => h.costBasisUsd !== null);
  const costBasisUsd = knownRows.reduce((s, h) => s + (h.costBasisUsd ?? 0), 0);
  const knownValue = knownRows.reduce((s, h) => s + h.valueUsd, 0);
  const returnUsd = knownRows.length > 0 ? knownValue - costBasisUsd : null;
  const returnPct =
    returnUsd !== null && costBasisUsd > 0
      ? (returnUsd / costBasisUsd) * 100
      : null;

  return { holdings, totals: { totalUsd, costBasisUsd, returnUsd, returnPct } };
}

// ---------------------------------------------------------------------------
// Allocation ring math (C9)
// ---------------------------------------------------------------------------

/** Ring renders at most this many segments; the tail groups into "Other". */
export const RING_MAX_SEGMENTS = 5;

/** Adjacent-segment token pairs contrast checks must hold ≥3:1 for
 *  (DS-10.2 non-text): consecutive pairs plus every possible wrap back to
 *  token 1 (segments are assigned tokens 1..n in order, n ∈ 2..5). */
export const REQUIRED_ALLOC_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [1, 3],
  [1, 4],
  [1, 5],
];

export interface RingSegment {
  assetId: string;
  ticker: string;
  valueUsd: number;
}

/** Largest-first segments, tail beyond RING_MAX_SEGMENTS grouped as "Other"
 *  (PROPOSED — keeps the ≥3:1 adjacency guarantee bounded at 5 tokens). */
export function ringSegments(
  holdings: ReadonlyArray<Pick<PortfolioHolding, "assetId" | "ticker" | "valueUsd">>,
  max: number = RING_MAX_SEGMENTS,
): RingSegment[] {
  const sorted = [...holdings]
    .filter((h) => h.valueUsd > 0)
    .sort((a, b) => b.valueUsd - a.valueUsd);
  if (sorted.length <= max) {
    return sorted.map((h) => ({
      assetId: h.assetId,
      ticker: h.ticker,
      valueUsd: h.valueUsd,
    }));
  }
  const head = sorted.slice(0, max - 1);
  const tail = sorted.slice(max - 1);
  return [
    ...head.map((h) => ({ assetId: h.assetId, ticker: h.ticker, valueUsd: h.valueUsd })),
    {
      assetId: "other",
      ticker: "Other",
      valueUsd: tail.reduce((s, h) => s + h.valueUsd, 0),
    },
  ];
}

/**
 * Legend percentages at `dp` decimals that sum EXACTLY to 100.00 — largest-
 * remainder allocation in integer units of 10^-dp (float addition of the
 * rounded values can't drift). All-zero input stays all-zero.
 */
export function roundPctsTo100(values: readonly number[], dp = 2): number[] {
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0 || values.length === 0) return values.map(() => 0);

  const scale = 10 ** dp;
  const exact = values.map((v) => (v / total) * 100 * scale);
  const floored = exact.map(Math.floor);
  let remainder = 100 * scale - floored.reduce((s, v) => s + v, 0);

  const order = exact
    .map((v, i) => ({ frac: v - floored[i], i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floored[i] += 1;
    remainder -= 1;
  }
  return floored.map((v) => v / scale);
}

export interface RingArc {
  /** `${segmentLength} ${gapToFullCircumference}` for stroke-dasharray. */
  dasharray: string;
  /** Negative accumulated offset — rotates each segment past the previous. */
  dashoffset: number;
}

/**
 * stroke-dasharray per segment: (pct/100)*C where C = 2πr; rotate accumulated
 * offset; round caps off. (Verbatim doc-12 recipe — the SVG applies a −90°
 * rotation so segment 1 starts at 12 o'clock.)
 */
export function ringArcs(pcts: readonly number[], r: number): RingArc[] {
  const circumference = 2 * Math.PI * r;
  let accumulated = 0;
  return pcts.map((pct) => {
    const length = (pct / 100) * circumference;
    const arc: RingArc = {
      dasharray: `${length} ${circumference - length}`,
      dashoffset: -accumulated || 0, // never -0 — it survives into the DOM attribute
    };
    accumulated += length;
    return arc;
  });
}

// ---------------------------------------------------------------------------
// Snapshot series (C11 chart + C10 sparklines)
// ---------------------------------------------------------------------------

/** Shape of one asset's entry inside portfolio_snapshots.per_asset_json. */
export interface SnapshotAssetValue {
  qty: number;
  markUsd: number;
  valueUsd: number;
  stale?: boolean;
}

export type ChartRange = "1w" | "1m" | "3m" | "all";

export const CHART_RANGES: readonly ChartRange[] = ["1w", "1m", "3m", "all"];

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** PROPOSED bucket sizes: 1w→hourly, 1m→6-hourly, 3m/all→daily. */
export const RANGE_CONFIG: Record<
  ChartRange,
  { spanMs: number | null; bucketMs: number }
> = {
  "1w": { spanMs: 7 * DAY_MS, bucketMs: HOUR_MS },
  "1m": { spanMs: 30 * DAY_MS, bucketMs: 6 * HOUR_MS },
  "3m": { spanMs: 90 * DAY_MS, bucketMs: DAY_MS },
  all: { spanMs: null, bucketMs: DAY_MS },
};

export interface ChartPoint {
  /** Bucket start, unix SECONDS (lightweight-charts time). */
  t: number;
  /** null = no snapshot in this bucket → whitespace gap, never interpolated. */
  usd: number | null;
}

/**
 * Last-snapshot-per-bucket aggregation. Buckets run from the first snapshot
 * inside the range (leading emptiness renders nothing, not a months-long
 * gap) through `nowMs`; interior and trailing empty buckets stay null — a
 * worker outage renders as a hole, exactly as it happened.
 */
export function bucketSnapshots(
  rows: ReadonlyArray<{ at: string; totalUsd: number }>,
  range: ChartRange,
  nowMs: number,
): ChartPoint[] {
  const { spanMs, bucketMs } = RANGE_CONFIG[range];
  const rangeStart = spanMs === null ? 0 : nowMs - spanMs;

  const inRange = rows
    .map((r) => ({ atMs: Date.parse(r.at), usd: r.totalUsd }))
    .filter((r) => Number.isFinite(r.atMs) && r.atMs >= rangeStart && r.atMs <= nowMs)
    .sort((a, b) => a.atMs - b.atMs);
  if (inRange.length === 0) return [];

  const firstBucket = Math.floor(inRange[0].atMs / bucketMs);
  const lastBucket = Math.floor(nowMs / bucketMs);

  const byBucket = new Map<number, number>();
  for (const row of inRange) {
    byBucket.set(Math.floor(row.atMs / bucketMs), row.usd); // ascending → last wins
  }

  const points: ChartPoint[] = [];
  for (let b = firstBucket; b <= lastBucket; b += 1) {
    points.push({
      t: Math.floor((b * bucketMs) / 1000),
      usd: byBucket.get(b) ?? null,
    });
  }
  return points;
}

/**
 * Per-asset sparkline from the newest ≤20 snapshots' per_asset_json blobs
 * (passed OLDEST-first). Tolerant of malformed rows; an asset absent from a
 * snapshot contributes no point. Fewer than 2 points → [] (C10 hides it).
 */
export function sparkFromSnapshots(
  perAssetJsons: readonly unknown[],
  assetId: string,
): number[] {
  const points: number[] = [];
  for (const blob of perAssetJsons) {
    if (blob === null || typeof blob !== "object") continue;
    const entry = (blob as Record<string, unknown>)[assetId];
    if (entry === null || typeof entry !== "object") continue;
    const value = (entry as { valueUsd?: unknown }).valueUsd;
    if (typeof value === "number" && Number.isFinite(value)) points.push(value);
  }
  return points.length >= 2 ? points : [];
}
