// Holdings pipeline (doc 12): fills → basis → positions → marks → statement.
// PROPOSED boundary implemented exactly as documented — holdings = registry
// assets bought through plans + any registry-asset balance detected on the
// account; buying-power primaries stay doc 06's. Zero Particle calls in this
// file: equities read from the user's own uaSolAddr over plain Solana RPC,
// SOL/ETH quantities come from the execution ledger. Marks are display-only.
//
// Module 13 parity note: enumeratePositions is THE position-enumeration entry
// point — the kill switch must liquidate what this returns, not a fork of it.

import {
  events,
  executions,
  jobs,
  plans,
  portfolioSnapshots,
  type Db,
} from "@retenix/db";
import { REGISTRY } from "@retenix/registry";
import {
  acceptableAddresses,
  assembleHoldings,
  buildBasisLedger,
  computeLegs,
  extractFillQty,
  getMarks,
  lastTradeMarks,
  parseSeqFromPeriodKey,
  PORTFOLIO_HOLDINGS_CACHE_TTL_MS,
  QTY_EPSILON,
  sparkFromSnapshots,
  type Fill,
  type MarksSource,
  type PortfolioHolding,
  type PortfolioTotals,
  type PositionInput,
} from "@retenix/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { clientEnv, env } from "../../env";
import { jsonRpc, SOLANA_TOKEN_PROGRAMS } from "./dust";

// ---------------------------------------------------------------------------
// Deps (network I/O injected — dust-scanner convention; tests fake these)
// ---------------------------------------------------------------------------

export interface HoldingsDeps {
  rpc: (url: string, method: string, params: unknown[]) => Promise<unknown>;
  fetchImpl: typeof fetch;
  now: () => Date;
}

export function defaultHoldingsDeps(): HoldingsDeps {
  return { rpc: jsonRpc, fetchImpl: fetch, now: () => new Date() };
}

/** The doc-12 feature flag drives the marks source app-side. */
export function marksSource(): MarksSource {
  return clientEnv.NEXT_PUBLIC_PORTFOLIO_LIVE === "1" ? "jupiter" : "last-trade";
}

// ---------------------------------------------------------------------------
// Fills — buys from executions, sells from events
// ---------------------------------------------------------------------------

interface QuoteJsonSlice {
  quote?: unknown;
  uaDetail?: unknown;
  fill?: { assetId?: unknown; usd?: unknown; qty?: unknown };
}

export interface FillsResult {
  fills: Fill[];
  /** Finished trades that could not be attributed to a registry asset.
   *  One of these means EVERY basis is suspect (the row could belong to any
   *  asset), so callers treat >0 as a global basis poison. */
  unattributed: number;
}

/** Sell outcomes that reduce the ledger. A failed/unverified leg left the
 *  position alone — counting it would silently overstate return. */
function sellCompleted(outcome: unknown): boolean {
  if (typeof outcome !== "string") return true; // absent = writer asserts success
  return ["finished", "settled", "sold", "ok", "success"].includes(
    outcome.toLowerCase(),
  );
}

export async function loadFills(db: Db, userId: string): Promise<FillsResult> {
  let unattributed = 0;
  const fills: Fill[] = [];

  // Buys: finished executions, scoped executions → jobs → plans → user.
  const buyRows = await db
    .select({
      periodKey: jobs.periodKey,
      paramsJson: plans.paramsJson,
      quoteJson: executions.quoteJson,
      createdAt: executions.createdAt,
    })
    .from(executions)
    .innerJoin(jobs, eq(executions.jobId, jobs.id))
    .innerJoin(plans, eq(jobs.planId, plans.id))
    .where(and(eq(plans.userId, userId), eq(executions.status, "finished")));

  for (const row of buyRows) {
    const at = row.createdAt.toISOString();
    const qj = (row.quoteJson ?? {}) as QuoteJsonSlice;

    // Preferred: the normalized fill the executor persists at finish.
    const fill = qj.fill;
    if (
      fill &&
      typeof fill.assetId === "string" &&
      typeof fill.usd === "number" &&
      Number.isFinite(fill.usd)
    ) {
      fills.push({
        side: "buy",
        assetId: fill.assetId,
        usd: fill.usd,
        qty:
          typeof fill.qty === "number" && Number.isFinite(fill.qty) && fill.qty > 0
            ? fill.qty
            : null,
        at,
      });
      continue;
    }

    // Fallback for pre-fill rows: the leg is derivable deterministically from
    // period_key seq + the plan's basket (params are immutable post-activation).
    const seq = parseSeqFromPeriodKey(row.periodKey);
    const legs = legsFromParams(row.paramsJson);
    const leg = seq !== null && legs !== null ? legs[seq] : undefined;
    if (!leg) {
      unattributed += 1;
      continue;
    }
    const asset = REGISTRY.find((a) => a.id === leg.assetId);
    fills.push({
      side: "buy",
      assetId: leg.assetId,
      usd: leg.usd,
      qty: asset
        ? extractFillQty([qj.uaDetail, qj.quote], acceptableAddresses(asset))
        : null,
      at,
    });
  }

  // Sells: kill.leg (doc 13 forward contract) + sell.receipt (doc 12) events.
  const sellRows = await db
    .select({
      type: events.type,
      payloadJson: events.payloadJson,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        inArray(events.type, ["kill.leg", "sell.receipt"]),
      ),
    );

  for (const row of sellRows) {
    const payload = (row.payloadJson ?? {}) as {
      assetId?: unknown;
      qty?: unknown;
      usd?: unknown;
      outcome?: unknown;
    };
    if (!sellCompleted(payload.outcome)) continue;
    if (typeof payload.assetId !== "string") {
      unattributed += 1;
      continue;
    }
    fills.push({
      side: "sell",
      assetId: payload.assetId,
      usd:
        typeof payload.usd === "number" && Number.isFinite(payload.usd)
          ? payload.usd
          : null,
      qty:
        typeof payload.qty === "number" &&
        Number.isFinite(payload.qty) &&
        payload.qty > 0
          ? payload.qty
          : null,
      at: row.createdAt.toISOString(),
    });
  }

  return { fills, unattributed };
}

/** Tolerant computeLegs over stored params — jobs only exist for broker
 *  plans, but a malformed row must degrade to "unattributed", never throw. */
function legsFromParams(
  paramsJson: unknown,
): ReturnType<typeof computeLegs> | null {
  const params = paramsJson as {
    amountUsd?: unknown;
    basket?: { assetId?: unknown; pct?: unknown }[];
  };
  if (
    typeof params?.amountUsd !== "number" ||
    !Array.isArray(params.basket) ||
    params.basket.some(
      (l) => typeof l?.assetId !== "string" || typeof l?.pct !== "number",
    )
  ) {
    return null;
  }
  try {
    return computeLegs(
      params as { amountUsd: number; basket: { assetId: string; pct: number }[] },
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Positions (the PROPOSED boundary; module 13's parity entry point)
// ---------------------------------------------------------------------------

interface SolanaTokenAccount {
  account?: {
    data?: {
      parsed?: {
        info?: {
          mint?: string;
          tokenAmount?: { uiAmountString?: string; decimals?: number };
        };
      };
    };
  };
}

/** Registry-equity balances on the user's own Solana address — the inverse
 *  of the dust scanner's exclusion filter, same programs, same RPC. */
export async function getRegistryBalances(
  deps: HoldingsDeps,
  uaSolAddr: string,
): Promise<Map<string, { qty: number; qtyHuman: string }>> {
  const out = new Map<string, { qty: number; qtyHuman: string }>();
  if (!uaSolAddr) return out; // account.bootstrap hasn't run — no source yet

  const byMint = new Map<string, string>(); // mint → assetId
  for (const asset of REGISTRY) {
    if (asset.kind === "equity" && asset.chainId === 101) {
      byMint.set(asset.address, asset.id);
    }
  }

  for (const programId of SOLANA_TOKEN_PROGRAMS) {
    const res = (await deps.rpc(env.RPC_URL_SOLANA, "getTokenAccountsByOwner", [
      uaSolAddr,
      { programId },
      { encoding: "jsonParsed" },
    ])) as { value?: SolanaTokenAccount[] };

    for (const acct of res.value ?? []) {
      const info = acct.account?.data?.parsed?.info;
      const assetId = info?.mint ? byMint.get(info.mint) : undefined;
      const ui = info?.tokenAmount?.uiAmountString;
      if (!assetId || typeof ui !== "string") continue;
      const qty = Number(ui);
      if (!Number.isFinite(qty) || qty <= QTY_EPSILON) continue;
      const existing = out.get(assetId);
      // Multiple accounts per mint are rare; a summed float loses the exact
      // human string, so qtyHuman keeps the single-account value when it can.
      out.set(assetId, {
        qty: (existing?.qty ?? 0) + qty,
        qtyHuman: existing ? String(existing.qty + qty) : ui,
      });
    }
  }
  return out;
}

/**
 * THE position-enumeration entry point (doc 13 reuses this for its
 * liquidation parity — never fork it): chain-detected registry equities on
 * uaSolAddr + SOL/ETH held as investments per the execution ledger.
 */
export async function enumeratePositions(
  db: Db,
  deps: HoldingsDeps,
  user: { userId: string; uaSolAddr: string },
): Promise<{ positions: PositionInput[]; fills: FillsResult }> {
  const fills = await loadFills(db, user.userId);
  const ledger = buildBasisLedger(fills.fills);
  const chain = await getRegistryBalances(deps, user.uaSolAddr);

  const positions: PositionInput[] = [];
  for (const [assetId, balance] of chain) {
    positions.push({ assetId, qty: balance.qty, qtyHuman: balance.qtyHuman });
  }
  // SOL/ETH: ledger-known net quantity only. A poisoned ledger cannot STATE a
  // quantity, so it renders nothing rather than a guess (doc 12 §failure modes).
  for (const assetId of ["sol", "eth"]) {
    const entry = ledger.get(assetId);
    if (entry && entry.basisKnown && entry.qty > QTY_EPSILON) {
      positions.push({ assetId, qty: entry.qty, qtyHuman: String(entry.qty) });
    }
  }
  return { positions, fills };
}

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

export interface HoldingsResponse extends PortfolioTotals {
  holdings: PortfolioHolding[];
  /** ISO timestamp of computation — the stale marker keys off it. */
  asOf: string;
  /** >0 = some finished trade couldn't be attributed; every basis is suspect
   *  (surfaced by the dev reconciliation banner, and all rows render "—"). */
  unattributedBuys: number;
}

export async function computeHoldings(
  db: Db,
  deps: HoldingsDeps,
  user: { userId: string; uaSolAddr: string },
): Promise<HoldingsResponse> {
  const { positions, fills } = await enumeratePositions(db, deps, user);
  const ledger = buildBasisLedger(fills.fills);

  // An unattributable trade means no per-asset basis can be trusted.
  const basis =
    fills.unattributed > 0 ? new Map<string, never>() : ledger;

  const positionAssets = REGISTRY.filter((a) =>
    positions.some((p) => p.assetId === a.id),
  );
  const marks = await getMarks({
    assets: positionAssets,
    source: marksSource(),
    lastTrade: lastTradeMarks(fills.fills),
    fetchImpl: deps.fetchImpl,
  });

  const { holdings, totals } = assembleHoldings({
    positions,
    basis,
    marks,
    assets: REGISTRY,
  });

  // Sparklines: the newest ≤20 snapshots, oldest-first for left-to-right time.
  const snapshotRows = await db
    .select({ perAssetJson: portfolioSnapshots.perAssetJson })
    .from(portfolioSnapshots)
    .where(eq(portfolioSnapshots.userId, user.userId))
    .orderBy(desc(portfolioSnapshots.at))
    .limit(20);
  const blobs = snapshotRows.map((r) => r.perAssetJson).reverse();
  for (const holding of holdings) {
    holding.spark = sparkFromSnapshots(blobs, holding.assetId);
  }

  return {
    holdings,
    ...totals,
    asOf: deps.now().toISOString(),
    unattributedBuys: fills.unattributed,
  };
}

// ---------------------------------------------------------------------------
// PROPOSED 30s per-user cache + serve-stale (summary.ts pattern verbatim)
// ---------------------------------------------------------------------------

const cache = new Map<string, HoldingsResponse>();

export const holdingsCache = {
  fresh(userId: string, now = Date.now()): HoldingsResponse | null {
    const entry = cache.get(userId);
    if (!entry) return null;
    return now - Date.parse(entry.asOf) < PORTFOLIO_HOLDINGS_CACHE_TTL_MS
      ? entry
      : null;
  },
  stale(userId: string): HoldingsResponse | null {
    return cache.get(userId) ?? null;
  },
  set(userId: string, response: HoldingsResponse): void {
    cache.set(userId, response);
  },
  clear(): void {
    cache.clear();
  },
};
