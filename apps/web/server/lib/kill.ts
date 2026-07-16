// Kill-switch server lib (doc 13) — leg planning, kill reconstruction from
// events rows, and the per-leg terminal verifier. Pure functions with
// injected deps (the dust.ts convention); the router owns transactions/locks.
//
// Enumeration parity (doc 13 hard rule): positions come from holdings.ts
// enumeratePositions — THE shared source with docs 06/12 — and primaries from
// getPrimaryAssets. This file only PLANS against what those return.
import { events, type Db } from "@retenix/db";
import { REGISTRY, type RegistryAsset } from "@retenix/registry";
import {
  KILL_CONVERT_FLOOR_USD,
  KILL_CONVERT_HAIRCUT,
  KILL_EVENTS,
  acceptableAddresses,
  extractSellFill,
  isKillTerminal,
  killLegConvertedReceipt,
  killLegPayloadSchema,
  killLegSoldReceipt,
  killLegUnverifiedReceipt,
  killReceiptText,
  killStartedPayloadSchema,
  networkName,
  refundedReceipt,
  type FeeTotals,
  type KillLegKind,
  type KillLegPayload,
  type KillLegState,
  type KillReceiptLeg,
  type KillReceiptPayload,
  type KillSkip,
  type KillStartedPayload,
  type MarkValue,
} from "@retenix/shared";
import {
  SUPPORTED_PRIMARY_TOKENS,
  parseFeeTotals,
  pollToTerminal,
  type TransactionSource,
} from "@retenix/ua";
import { and, desc, eq, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Leg planning (pure — the doc 13 §orchestration steps 1–3)
// ---------------------------------------------------------------------------

/** A planned leg before persistence (the router assigns legId/killId). */
export interface PlannedLeg {
  kind: KillLegKind;
  assetId: string;
  symbol: string;
  chainId: number;
  network: string;
  token?: string;
  amountHuman?: string;
  expectUsdc?: number;
  primaryType?: string;
  usdEst: number | null;
}

/** Structural slice of the SDK's IAssetsResponse — tests need no SDK types. */
export interface PrimaryAssetInput {
  tokenType: string;
  amountInUSD: number;
  chainAggregation?: { amountInUSD?: number; token?: { chainId?: number } }[];
}

const CONVERT_FALLBACK_CHAIN = 42161; // Arbitrum One — RetenixPolicy's home

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Destination chain for a convert: where most of the primary already sits —
 *  most of the conversion stays local, UA pulls stragglers cross-chain. */
function convertChainFor(primary: PrimaryAssetInput): number {
  let best = CONVERT_FALLBACK_CHAIN;
  let bestUsd = -1;
  for (const agg of primary.chainAggregation ?? []) {
    const usd = agg.amountInUSD ?? 0;
    const chainId = agg.token?.chainId;
    if (typeof chainId === "number" && usd > bestUsd) {
      best = chainId;
      bestUsd = usd;
    }
  }
  return best;
}

/**
 * Plan the liquidation batch: one sell per registry-EQUITY position (sell-all,
 * qtyHuman byte-identical — never floated), one convert per non-USDC primary
 * above the floor. USDC is untouched. SOL/ETH ledger positions are SUBSUMED
 * by their primary's convert leg — the primary balance IS those funds, and
 * planning both would double-liquidate.
 */
export function planKillLegs(input: {
  positions: readonly { assetId: string; qty: number; qtyHuman?: string }[];
  primaries: readonly PrimaryAssetInput[];
  registry?: readonly RegistryAsset[];
  marks: ReadonlyMap<string, MarkValue>;
}): { legs: PlannedLeg[]; skipped: KillSkip[] } {
  const registry = input.registry ?? REGISTRY;
  const legs: PlannedLeg[] = [];
  const skipped: KillSkip[] = [];

  const convertible = new Set(
    input.primaries
      .filter(
        (p) => p.tokenType !== "usdc" && p.amountInUSD > KILL_CONVERT_FLOOR_USD,
      )
      .map((p) => p.tokenType),
  );

  for (const position of input.positions) {
    const asset = registry.find((a) => a.id === position.assetId);
    if (!asset) {
      // Defensive: enumeratePositions only returns registry ids today, but a
      // drifted row must be listed, never silently dropped (continue-and-report).
      skipped.push({
        assetId: position.assetId,
        symbol: position.assetId.toUpperCase(),
        reason: "unknown-asset",
      });
      continue;
    }
    if (asset.kind !== "equity") {
      // SOL/ETH ledger positions: liquidated through the primary convert leg.
      // No convert leg (balance at/below floor) → the value is sub-floor;
      // list it so the completion screen stays honest.
      if (!convertible.has(asset.id)) {
        skipped.push({
          assetId: asset.id,
          symbol: asset.ticker,
          reason: "below-floor",
        });
      }
      continue;
    }
    const mark = input.marks.get(asset.id);
    legs.push({
      kind: "sell",
      assetId: asset.id,
      symbol: asset.ticker,
      chainId: asset.chainId,
      network: networkName(asset.chainId), // copy-canon-allow
      token: asset.address,
      // getRegistryBalances always carries qtyHuman for equities; the String
      // fallback only ever fires for ledger rows, which are never sells.
      amountHuman: position.qtyHuman ?? String(position.qty),
      usdEst: mark ? round2(position.qty * mark.usd) : null,
    });
  }

  for (const primary of input.primaries) {
    if (primary.tokenType === "usdc") continue; // USDC is the destination
    if (primary.amountInUSD <= 0) continue; // nothing held — not a skip
    if (primary.amountInUSD <= KILL_CONVERT_FLOOR_USD) {
      skipped.push({
        assetId: primary.tokenType,
        symbol: primary.tokenType.toUpperCase(),
        usd: round2(primary.amountInUSD),
        reason: "below-floor",
      });
      continue;
    }
    const chainId = convertChainFor(primary);
    legs.push({
      kind: "convert",
      assetId: primary.tokenType,
      symbol: primary.tokenType.toUpperCase(),
      chainId,
      network: networkName(chainId), // copy-canon-allow
      expectUsdc: round2(primary.amountInUSD * KILL_CONVERT_HAIRCUT),
      primaryType: primary.tokenType,
      usdEst: round2(primary.amountInUSD),
    });
  }

  return { legs, skipped };
}

// ---------------------------------------------------------------------------
// Kill reconstruction (events rows are the truth — crash resilience)
// ---------------------------------------------------------------------------

export interface KillRows {
  startedEventId: string;
  started: KillStartedPayload;
  legs: { eventId: string; payload: KillLegPayload }[];
  receipt?: { eventId: string; payload: KillReceiptPayload };
}

/** Load one kill's rows (by killId, or the user's latest when omitted). */
export async function loadKill(
  db: Db,
  userId: string,
  killId?: string,
): Promise<KillRows | null> {
  const startedRows = await db
    .select({ id: events.id, payloadJson: events.payloadJson })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.type, KILL_EVENTS.started),
        ...(killId
          ? [sql`${events.payloadJson}->>'killId' = ${killId}`]
          : []),
      ),
    )
    .orderBy(desc(events.createdAt))
    .limit(1);
  if (startedRows.length === 0) return null;

  const started = killStartedPayloadSchema.parse(startedRows[0].payloadJson);
  const resolvedKillId = started.killId;

  const [legRows, receiptRows] = await Promise.all([
    db
      .select({ id: events.id, payloadJson: events.payloadJson, createdAt: events.createdAt })
      .from(events)
      .where(
        and(
          eq(events.userId, userId),
          eq(events.type, KILL_EVENTS.leg),
          sql`${events.payloadJson}->>'killId' = ${resolvedKillId}`,
        ),
      )
      .orderBy(events.createdAt),
    db
      .select({ id: events.id, payloadJson: events.payloadJson })
      .from(events)
      .where(
        and(
          eq(events.userId, userId),
          eq(events.type, KILL_EVENTS.receipt),
          sql`${events.payloadJson}->>'killId' = ${resolvedKillId}`,
        ),
      )
      .limit(1),
  ]);

  return {
    startedEventId: startedRows[0].id,
    started,
    legs: legRows.map((row) => ({
      eventId: row.id,
      payload: killLegPayloadSchema.parse(row.payloadJson) as KillLegPayload,
    })),
    receipt: receiptRows[0]
      ? {
          eventId: receiptRows[0].id,
          payload: receiptRows[0].payloadJson as KillReceiptPayload,
        }
      : undefined,
  };
}

/** The user's active kill: latest kill.started with no kill.receipt yet.
 *  (Zero-leg kills write their receipt in the same flow, so they never
 *  linger as active.) */
export async function findActiveKill(
  db: Db,
  userId: string,
): Promise<KillRows | null> {
  const latest = await loadKill(db, userId);
  if (!latest || latest.receipt) return null;
  return latest;
}

export const allTerminal = (legs: readonly { payload: KillLegPayload }[]): boolean =>
  legs.every((l) => isKillTerminal(l.payload.outcome));

// ---------------------------------------------------------------------------
// Terminal verification (recordSell posture, hardened — plan a.1's 4 checks;
// txId-uniqueness is the router's, it needs the row lock)
// ---------------------------------------------------------------------------

/** Owner extraction from the (OQ5-unfrozen) polled payload — the sweep rule. */
export function extractOwners(t: Record<string, unknown>): string[] {
  const owners: string[] = [];
  const sao = t.smartAccountOptions as { ownerAddress?: unknown } | undefined;
  if (typeof sao?.ownerAddress === "string") owners.push(sao.ownerAddress);
  if (typeof t.sender === "string" && t.sender) owners.push(t.sender);
  return owners;
}

/** Address candidates that count as "this leg's asset left the account". */
export function legAcceptAddresses(leg: {
  kind: KillLegKind;
  assetId: string;
  token?: string;
  primaryType?: string;
}): string[] {
  if (leg.kind === "sell") {
    const asset = REGISTRY.find((a) => a.id === leg.assetId);
    if (asset) return acceptableAddresses(asset);
    return leg.token ? [leg.token] : [];
  }
  // convert: the funding primary's per-chain addresses (the SDK's own list).
  return SUPPORTED_PRIMARY_TOKENS.filter(
    (t) => (t.type as string | undefined) === leg.primaryType,
  ).map((t) => t.address);
}

export type LegVerification =
  | { kind: "still-settling" }
  | {
      kind: "verified";
      state: Extract<KillLegState, "settled" | "refunded" | "failed" | "unverified">;
      patch: Partial<KillLegPayload>;
    };

/**
 * Re-derive a leg's terminal truth from the server's OWN poll (claims are
 * never trusted): outcome, owner match, asset match, extraction. The caller
 * writes the patch under the users-row lock.
 */
export async function verifyLegTerminal(
  deps: { ua: TransactionSource },
  leg: KillLegPayload,
  transactionId: string,
  session: { eoaAddr: string; uaSolAddr: string },
  feesQuoted?: FeeTotals,
): Promise<LegVerification> {
  let polled: { outcome: string; t: Record<string, unknown> };
  try {
    polled = (await pollToTerminal(deps.ua, transactionId, {
      intervalMs: 1500,
      timeoutMs: 6000,
    })) as { outcome: string; t: Record<string, unknown> };
  } catch {
    return { kind: "still-settling" };
  }
  if (polled.outcome === "timeout") return { kind: "still-settling" };

  // Owner check (check 2): a tx provably from another account is a failed
  // claim, not a settled leg.
  const owners = extractOwners(polled.t).map((o) => o.toLowerCase());
  const mine = [session.eoaAddr, session.uaSolAddr]
    .filter(Boolean)
    .map((o) => o.toLowerCase());
  if (owners.length > 0 && !owners.some((o) => mine.includes(o))) {
    return {
      kind: "verified",
      state: "failed",
      patch: {
        transactionId,
        serverVerified: true,
        error: "did not match this account",
      },
    };
  }

  let fees: FeeTotals | undefined;
  try {
    fees = parseFeeTotals(polled.t as { feeQuotes?: unknown[] });
    // parseFeeTotals collapses a missing split to zeros; an all-zero parse
    // means "the payload carried no fee data", not "free" — the client's
    // quoted split is the honest fallback there (G8 discipline).
    if (fees.total === 0 && fees.gas === 0 && fees.service === 0 && fees.lp === 0) {
      fees = undefined;
    }
  } catch {
    fees = undefined;
  }
  const feeFields: Partial<KillLegPayload> = fees
    ? { fees, feeSource: "settled" }
    : feesQuoted
      ? { fees: feesQuoted, feeSource: "quoted" }
      : {};

  const fill = extractSellFill([polled.t], legAcceptAddresses(leg));

  if (polled.outcome === "refunded") {
    // REFUND (UA 8–11): money came back, position still held. Doc-08 wording.
    const usd = fill.usd ?? leg.usdEst ?? 0;
    return {
      kind: "verified",
      state: "refunded",
      patch: {
        transactionId,
        serverVerified: true,
        ...feeFields,
        receipt: refundedReceipt(usd),
      },
    };
  }

  // finished — asset check (check 3): the tx must show THIS leg's token
  // leaving the account, or it cannot be counted as a fill (a session-only
  // attacker must not mint phantom fills from an unrelated finished tx).
  if (fill.qty === null) {
    return {
      kind: "verified",
      state: "unverified",
      patch: {
        transactionId,
        serverVerified: false,
        ...feeFields,
        receipt: killLegUnverifiedReceipt(leg.symbol),
      },
    };
  }

  return {
    kind: "verified",
    state: "settled",
    patch: {
      transactionId,
      serverVerified: true,
      qty: fill.qty,
      usd: fill.usd ?? undefined,
      ...feeFields,
      receipt:
        leg.kind === "sell"
          ? killLegSoldReceipt(leg.symbol)
          : killLegConvertedReceipt(leg.symbol),
    },
  };
}

// ---------------------------------------------------------------------------
// The aggregate receipt (built, and REBUILT after post-aggregate retries)
// ---------------------------------------------------------------------------

const zeroFees: FeeTotals = { gas: 0, service: 0, lp: 0, total: 0 };

function sumFees(legs: readonly KillLegPayload[]): FeeTotals {
  const out = { ...zeroFees };
  for (const leg of legs) {
    if (leg.outcome !== "settled" || !leg.fees) continue;
    out.gas += leg.fees.gas;
    out.service += leg.fees.service;
    out.lp += leg.fees.lp;
    out.total += leg.fees.total;
  }
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { gas: r(out.gas), service: r(out.service), lp: r(out.lp), total: r(out.total) };
}

export function buildKillReceipt(
  started: KillStartedPayload,
  legs: readonly KillLegPayload[],
  now: () => Date = () => new Date(),
): KillReceiptPayload {
  const liquidated = legs.filter((l) => l.outcome === "settled").length;
  const total = legs.length;
  const retryable = legs.filter(
    (l) => isKillTerminal(l.outcome) && l.outcome !== "settled",
  ).length;
  const revoked = started.revoke.state === "confirmed";

  const receiptLegs: KillReceiptLeg[] = legs.map((l) => ({
    chainId: l.chainId,
    network: l.network,
    symbol: l.symbol,
    usd: l.usd ?? l.usdEst ?? 0,
    ...(l.transactionId ? { transactionId: l.transactionId } : {}),
    outcome: l.outcome,
    serverVerified: l.serverVerified ?? false,
    ...(l.fees ? { fees: l.fees, feeSource: l.feeSource ?? "none" } : {}),
    ...(l.error ? { error: l.error } : {}),
  }));

  return {
    killId: started.killId,
    receipt: killReceiptText({ liquidated, total, retryable, revoked }),
    liquidated,
    total,
    retryable,
    revoked,
    fees: sumFees(legs),
    legs: receiptLegs,
    createdAt: now().toISOString(),
  };
}
