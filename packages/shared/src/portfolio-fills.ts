// Row → Fill mappers shared by the web holdings route and the worker
// snapshot cron (doc 12). The SEMANTICS of what counts as a fill — status
// filters, event types, outcome rules, attribution fallbacks — live here
// exactly once; each process keeps only its thin SQL/RPC plumbing. Module
// 13's position-enumeration parity depends on this staying single-sourced.

import { computeLegs } from "./basket";
import {
  acceptableAddresses,
  extractFillQty,
  parseSeqFromPeriodKey,
  QTY_EPSILON,
  type Fill,
  type PortfolioAssetMeta,
} from "./portfolio";

/** Sell fills come from these events (kill.leg = doc 13's forward contract,
 *  sell.receipt = doc 12's sell-from-detail). */
export const SELL_FILL_EVENT_TYPES = ["kill.leg", "sell.receipt"] as const;

/** Classic SPL Token + Token-2022 — xStocks live under Token-2022, older SPL
 *  assets under classic; every Solana owner scan queries both (the dust
 *  scanner, the holdings route, and the snapshot cron share this list). */
export const SOLANA_TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

/** Sell outcomes that reduce the ledger. A failed/unverified leg left the
 *  position alone — counting it would silently overstate return. An absent
 *  outcome means the writer only records successes. */
export function sellCompleted(outcome: unknown): boolean {
  if (typeof outcome !== "string") return true;
  return ["finished", "settled", "sold", "ok", "success"].includes(
    outcome.toLowerCase(),
  );
}

export interface ExecutionFillRow {
  periodKey: string;
  paramsJson: unknown;
  quoteJson: unknown;
  atIso: string;
}

export type FillMapping =
  | { fill: Fill }
  | { unattributed: true }
  | { skipped: true };

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
    params.basket.length === 0 ||
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

/**
 * A finished execution → buy fill. Attribution order: the normalized
 * quote_json.fill the executor writes at finish; else the deterministic
 * period_key seq into the plan's computed legs (params are immutable
 * post-activation), with qty read from the persisted UA payloads. A row
 * neither path can attribute could have been ANY asset → `unattributed`
 * (callers treat one of those as a global basis poison).
 */
export function buyFillFromExecutionRow(
  row: ExecutionFillRow,
  assets: readonly PortfolioAssetMeta[],
): FillMapping {
  const qj = (row.quoteJson ?? {}) as {
    quote?: unknown;
    uaDetail?: unknown;
    fill?: { assetId?: unknown; usd?: unknown; qty?: unknown };
  };

  const fill = qj.fill;
  if (
    fill &&
    typeof fill.assetId === "string" &&
    typeof fill.usd === "number" &&
    Number.isFinite(fill.usd)
  ) {
    return {
      fill: {
        side: "buy",
        assetId: fill.assetId,
        usd: fill.usd,
        qty:
          typeof fill.qty === "number" &&
          Number.isFinite(fill.qty) &&
          fill.qty > 0
            ? fill.qty
            : null,
        at: row.atIso,
      },
    };
  }

  const seq = parseSeqFromPeriodKey(row.periodKey);
  const legs = seq !== null ? legsFromParams(row.paramsJson) : null;
  const leg = legs?.[seq as number];
  if (!leg) return { unattributed: true };

  const asset = assets.find((a) => a.id === leg.assetId);
  return {
    fill: {
      side: "buy",
      assetId: leg.assetId,
      usd: leg.usd,
      qty: asset
        ? extractFillQty([qj.uaDetail, qj.quote], acceptableAddresses(asset))
        : null,
      at: row.atIso,
    },
  };
}

/**
 * A kill.leg / sell.receipt event → sell fill. Non-completed outcomes are
 * skipped (they moved nothing); a completed sell with no assetId could have
 * been any asset → `unattributed`.
 */
export function sellFillFromEvent(row: {
  payloadJson: unknown;
  atIso: string;
}): FillMapping {
  const payload = (row.payloadJson ?? {}) as {
    assetId?: unknown;
    qty?: unknown;
    usd?: unknown;
    outcome?: unknown;
  };
  if (!sellCompleted(payload.outcome)) return { skipped: true };
  if (typeof payload.assetId !== "string") return { unattributed: true };
  return {
    fill: {
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
      at: row.atIso,
    },
  };
}

/** Fold a list of mappings into fills + the unattributed count. */
export function collectFills(mappings: readonly FillMapping[]): {
  fills: Fill[];
  unattributed: number;
} {
  const fills: Fill[] = [];
  let unattributed = 0;
  for (const m of mappings) {
    if ("fill" in m) fills.push(m.fill);
    else if ("unattributed" in m) unattributed += 1;
  }
  return { fills, unattributed };
}

// ---------------------------------------------------------------------------
// Solana token-account parsing (jsonParsed) → registry-equity positions
// ---------------------------------------------------------------------------

interface TokenAccountLike {
  account?: {
    data?: {
      parsed?: {
        info?: {
          mint?: string;
          tokenAmount?: { uiAmountString?: string };
        };
      };
    };
  };
}

/**
 * Parse getTokenAccountsByOwner(jsonParsed) values, keeping only registry
 * EQUITY mints. Accumulates into `into` so callers can merge the classic and
 * Token-2022 program scans. qtyHuman keeps the exact RPC string while the
 * asset has a single account (the common case) — sell-all never round-trips
 * through a float there.
 */
export function accumulateTokenAccounts(
  value: unknown,
  assets: readonly PortfolioAssetMeta[],
  into: Map<string, { qty: number; qtyHuman: string }>,
): void {
  const byMint = new Map<string, string>();
  for (const asset of assets) {
    if (asset.kind === "equity" && asset.chainId === 101) {
      byMint.set(asset.address, asset.id);
    }
  }
  if (!Array.isArray(value)) return;
  for (const acct of value as TokenAccountLike[]) {
    const info = acct.account?.data?.parsed?.info;
    const assetId = info?.mint ? byMint.get(info.mint) : undefined;
    const ui = info?.tokenAmount?.uiAmountString;
    if (!assetId || typeof ui !== "string") continue;
    const qty = Number(ui);
    if (!Number.isFinite(qty) || qty <= QTY_EPSILON) continue;
    const existing = into.get(assetId);
    into.set(assetId, {
      qty: (existing?.qty ?? 0) + qty,
      qtyHuman: existing ? String(existing.qty + qty) : ui,
    });
  }
}
