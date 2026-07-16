// Display marks adapter (doc 12, PROPOSED — the marks source is an open
// product decision; owner review by W3). One function serves both the web
// route and the worker snapshot cron so the statement and its history can
// never disagree about where prices come from.
//
// Sources, in order of preference under source="jupiter":
//   1. Jupiter Price API v3 by mint (free tier; unpriced mints are OMITTED
//      from the response, not nulled) — SPL assets incl. native SOL.
//   2. Last-trade price derived from the user's own fills (+ stale flag).
//   3. Nothing — the asset is absent from the result and the row renders
//      no fabricated number.
//
// ETH is not Jupiter-priceable and pinning a bridged-WETH mint would bypass
// the registry's mint-verification procedure (G11) — ETH resolves via
// last-trade only in v1 (flagged in HANDOFF).
//
// Marks are DISPLAY-ONLY by construction: nothing here touches execution
// pricing (executions price via UA quotes, doc 08). A poisoned feed can
// mislead a chart, never move money.

import { SOL_NATIVE_MINT, type MarkValue } from "./portfolio";

export const JUPITER_PRICE_URL = "https://lite-api.jup.ag/price/v3";

const JUPITER_TIMEOUT_MS = 5_000;

export type MarksSource = "jupiter" | "last-trade";

export interface MarkAssetInput {
  id: string;
  chainId: number;
  address: string;
}

/** The mint Jupiter knows this asset by; null = not Jupiter-priceable. */
export function jupiterMintFor(asset: MarkAssetInput): string | null {
  if (asset.chainId !== 101) return null; // ETH-native etc.
  return asset.id === "sol" ? SOL_NATIVE_MINT : asset.address;
}

async function fetchJupiterPrices(
  mints: readonly string[],
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (mints.length === 0) return out;
  // ≤50 ids per call (documented cap); the registry tops out far below it.
  const res = await fetchImpl(`${baseUrl}?ids=${mints.join(",")}`, {
    signal: AbortSignal.timeout(JUPITER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`jupiter price http ${res.status}`);
  const body = (await res.json()) as Record<string, { usdPrice?: unknown }>;
  for (const mint of mints) {
    const price = body?.[mint]?.usdPrice;
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      out.set(mint, price);
    }
  }
  return out;
}

/**
 * Resolve display marks for `assets`. Every failure path degrades toward
 * `lastTrade` (with `stale: true`), and an asset neither source can price is
 * simply absent — callers render "—"/omit rather than invent a number.
 */
export async function getMarks(opts: {
  assets: readonly MarkAssetInput[];
  source: MarksSource;
  lastTrade: ReadonlyMap<string, number>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): Promise<Map<string, MarkValue>> {
  const { assets, source, lastTrade } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? JUPITER_PRICE_URL;

  let live = new Map<string, number>();
  if (source === "jupiter") {
    const mints = assets
      .map(jupiterMintFor)
      .filter((m): m is string => m !== null);
    try {
      live = await fetchJupiterPrices([...new Set(mints)], fetchImpl, baseUrl);
    } catch {
      live = new Map(); // whole-fetch failure → everything last-trade
    }
  }

  const out = new Map<string, MarkValue>();
  for (const asset of assets) {
    const mint = jupiterMintFor(asset);
    const livePrice = mint !== null ? live.get(mint) : undefined;
    if (livePrice !== undefined) {
      out.set(asset.id, { usd: livePrice, stale: false, source: "jupiter" });
      continue;
    }
    const last = lastTrade.get(asset.id);
    if (last !== undefined && Number.isFinite(last) && last > 0) {
      out.set(asset.id, { usd: last, stale: true, source: "last-trade" });
    }
  }
  return out;
}
