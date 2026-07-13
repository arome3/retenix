import { ACCOUNT_SUMMARY_CACHE_TTL_MS, networkName } from "@retenix/shared";
import type { IAssetsResponse } from "@retenix/ua";

/*
 * account.summary aggregation (doc 06) — pure math over getPrimaryAssets()
 * plus the PROPOSED 30s per-user server cache.
 *
 * The response contract is doc 06's, verbatim:
 *   { buyingPowerUsd, sources: {chainId, name, usd, pct}[],
 *     assets: {symbol, usd, perChain: {chainId, usd}[]}[], asOf }
 *
 * All USD figures arrive from the SDK as plain numbers (IAssetsResponse), and
 * leave as plain numbers — no bigint/superjson concern on this wire.
 */

export interface SummarySource {
  chainId: number;
  name: string;
  usd: number;
  pct: number;
}

export interface SummaryAsset {
  symbol: string;
  usd: number;
  perChain: { chainId: number; usd: number }[];
}

export interface AccountSummary {
  buyingPowerUsd: number;
  sources: SummarySource[];
  assets: SummaryAsset[];
  asOf: string;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Fold the five primary assets' per-chain aggregation into one buying-power
 * number, per-network sources (usd > 0 only, largest first — the pill count is
 * `sources.length`), and per-asset rows for the breakdown sheet.
 */
export function summarize(resp: IAssetsResponse, asOf: Date): AccountSummary {
  const byChain = new Map<number, number>();
  const assets: SummaryAsset[] = [];
  let total = 0;

  for (const asset of resp.assets ?? []) {
    const perChain: { chainId: number; usd: number }[] = [];
    let assetUsd = 0;
    for (const agg of asset.chainAggregation ?? []) {
      const usd = agg.amountInUSD ?? 0;
      if (usd <= 0) continue;
      assetUsd += usd;
      perChain.push({ chainId: agg.token.chainId, usd });
      byChain.set(agg.token.chainId, (byChain.get(agg.token.chainId) ?? 0) + usd);
    }
    // Sum per-chain rows rather than trusting asset.amountInUSD — the two agree
    // on a well-formed response, and the fold cannot double-count on a bad one.
    if (assetUsd <= 0) continue;
    total += assetUsd;
    perChain.sort((a, b) => b.usd - a.usd);
    assets.push({
      symbol: (asset.tokenType ?? "").toUpperCase(),
      usd: assetUsd,
      perChain,
    });
  }

  const sources: SummarySource[] = [...byChain.entries()]
    .map(([chainId, usd]) => ({
      chainId,
      name: networkName(chainId),
      usd,
      pct: total > 0 ? round2((usd / total) * 100) : 0,
    }))
    .sort((a, b) => b.usd - a.usd);

  assets.sort((a, b) => b.usd - a.usd);

  return { buyingPowerUsd: total, sources, assets, asOf: asOf.toISOString() };
}

// ---------------------------------------------------------------------------
// PROPOSED 30s per-user cache. In-memory and per-instance: exactly right for
// the dev/demo single server, best-effort on serverless (a cold instance just
// refetches). The stale entry is deliberately kept forever — on an upstream
// failure the route serves it with its OLD asOf, and C1 renders the honest
// stale marker instead of a spinner over money (doc 06 stale-balance honesty).
// ---------------------------------------------------------------------------

const cache = new Map<string, AccountSummary>();

export const summaryCache = {
  /** Entry younger than the TTL, else null. */
  fresh(userId: string, now = Date.now()): AccountSummary | null {
    const entry = cache.get(userId);
    if (!entry) return null;
    return now - Date.parse(entry.asOf) < ACCOUNT_SUMMARY_CACHE_TTL_MS ? entry : null;
  },
  /** Any entry regardless of age — the last-known-truth fallback. */
  stale(userId: string): AccountSummary | null {
    return cache.get(userId) ?? null;
  },
  set(userId: string, summary: AccountSummary): void {
    cache.set(userId, summary);
  },
  /** Test hook. */
  clear(): void {
    cache.clear();
  },
};
