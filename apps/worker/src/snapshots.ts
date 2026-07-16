// Hourly portfolio snapshots (doc 12, PROPOSED — the portfolio_snapshots
// table is a spec-silent extension recorded in the schema and HANDOFF).
// Writes one row per user per tick: total portfolio USD + per-asset values,
// which power C11's chart ranges and C10's sparklines. Display-only marks —
// nothing here prices an execution, and a tick that cannot state a number
// writes nothing (a worker outage renders as an honest gap, never an
// interpolation).
//
// Same semantics as the web holdings route by construction: the fill mappers,
// basis ledger, marks adapter and assembly all come from @retenix/shared.
// Zero Particle calls (OQ2 stays untouched): equities from the user's own
// uaSolAddr over plain Solana RPC, SOL/ETH from the execution ledger.

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
  accumulateTokenAccounts,
  assembleHoldings,
  buildBasisLedger,
  buyFillFromExecutionRow,
  collectFills,
  getMarks,
  lastTradeMarks,
  QTY_EPSILON,
  SELL_FILL_EVENT_TYPES,
  sellFillFromEvent,
  SOLANA_TOKEN_PROGRAMS,
  type PositionInput,
  type SnapshotAssetValue,
} from "@retenix/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { env } from "../env";
import { breadcrumb, captureError } from "./notify";

export interface SnapshotDeps {
  rpc: (url: string, method: string, params: unknown[]) => Promise<unknown>;
  fetchImpl: typeof fetch;
  now: () => Date;
}

async function jsonRpc(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} → HTTP ${res.status}`);
  const body = (await res.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message ?? `rpc ${method} failed`);
  return body.result;
}

export function defaultSnapshotDeps(): SnapshotDeps {
  return { rpc: jsonRpc, fetchImpl: fetch, now: () => new Date() };
}

/** Marks are user-independent — memoize by URL so a tick over N users makes
 *  ONE Jupiter call, while getMarks stays the single merge authority. */
function memoizedFetch(fetchImpl: typeof fetch): typeof fetch {
  const memo = new Map<string, Promise<{ ok: boolean; status: number; body: unknown }>>();
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const key = String(input);
    let entry = memo.get(key);
    if (!entry) {
      entry = (async () => {
        const res = await fetchImpl(input, init);
        return { ok: res.ok, status: res.status, body: res.ok ? await res.json() : null };
      })();
      memo.set(key, entry);
    }
    const { ok, status, body } = await entry;
    return {
      ok,
      status,
      json: () => Promise.resolve(body),
    } as Response;
  }) as typeof fetch;
}

interface SnapshotUser {
  id: string;
  uaSolAddr: string;
}

/** Users worth snapshotting: plan-owners with a finished execution (they may
 *  hold something) ∪ users with existing snapshots (their history continues —
 *  including the honest drop to zero after a full exit). */
async function snapshotUsers(db: Db): Promise<SnapshotUser[]> {
  const rows = await db.execute<{ id: string; ua_sol_addr: string }>(sql`
    select distinct u.id, u.ua_sol_addr from users u
      join plans p on p.user_id = u.id
      join jobs j on j.plan_id = p.id
      join executions e on e.job_id = j.id
     where e.status = 'finished'
    union
    select distinct u.id, u.ua_sol_addr from users u
      join portfolio_snapshots s on s.user_id = u.id
  `);
  return rows.rows.map((r) => ({ id: r.id, uaSolAddr: r.ua_sol_addr }));
}

async function positionsFor(
  db: Db,
  deps: SnapshotDeps,
  user: SnapshotUser,
): Promise<{
  positions: PositionInput[];
  fills: ReturnType<typeof collectFills>;
}> {
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
    .where(and(eq(plans.userId, user.id), eq(executions.status, "finished")));
  const sellRows = await db
    .select({ payloadJson: events.payloadJson, createdAt: events.createdAt })
    .from(events)
    .where(
      and(
        eq(events.userId, user.id),
        inArray(events.type, [...SELL_FILL_EVENT_TYPES]),
      ),
    );

  const fills = collectFills([
    ...buyRows.map((row) =>
      buyFillFromExecutionRow(
        {
          periodKey: row.periodKey,
          paramsJson: row.paramsJson,
          quoteJson: row.quoteJson,
          atIso: row.createdAt.toISOString(),
        },
        REGISTRY,
      ),
    ),
    ...sellRows.map((row) =>
      sellFillFromEvent({
        payloadJson: row.payloadJson,
        atIso: row.createdAt.toISOString(),
      }),
    ),
  ]);
  const ledger = buildBasisLedger(fills.fills);

  const chain = new Map<string, { qty: number; qtyHuman: string }>();
  if (user.uaSolAddr) {
    for (const programId of SOLANA_TOKEN_PROGRAMS) {
      const res = (await deps.rpc(
        env.RPC_URL_SOLANA,
        "getTokenAccountsByOwner",
        [user.uaSolAddr, { programId }, { encoding: "jsonParsed" }],
      )) as { value?: unknown };
      accumulateTokenAccounts(res.value, REGISTRY, chain);
    }
  }

  const positions: PositionInput[] = [];
  for (const [assetId, balance] of chain) {
    positions.push({ assetId, qty: balance.qty, qtyHuman: balance.qtyHuman });
  }
  for (const assetId of ["sol", "eth"]) {
    const entry = ledger.get(assetId);
    if (entry && entry.basisKnown && entry.qty > QTY_EPSILON) {
      positions.push({ assetId, qty: entry.qty });
    }
  }
  return { positions, fills };
}

/**
 * One tick: value every snapshot-worthy user and insert a row each. Per-user
 * failures are captured and skipped — one bad RPC answer must not hole every
 * user's chart. Returns counts for the boot log / tests.
 *
 * opts.userIds restricts the run to specific users — the seam scoped
 * backfills (doc 16 demo seeding) and hermetic tests share.
 */
export async function snapshotTick(
  ctx: { db: Db },
  deps: SnapshotDeps = defaultSnapshotDeps(),
  opts: { userIds?: string[] } = {},
): Promise<{ scanned: number; written: number }> {
  let targets = await snapshotUsers(ctx.db);
  if (opts.userIds) {
    targets = targets.filter((t) => opts.userIds?.includes(t.id));
  }
  if (targets.length === 0) return { scanned: 0, written: 0 };

  const fetchOnce = memoizedFetch(deps.fetchImpl);
  let written = 0;

  for (const user of targets) {
    try {
      const { positions, fills } = await positionsFor(ctx.db, deps, user);

      // New user with nothing held: skip (no eternal zero rows). A user with
      // history gets the honest zero — their exit is part of the statement.
      if (positions.length === 0) {
        const [existing] = await ctx.db
          .select({ id: portfolioSnapshots.id })
          .from(portfolioSnapshots)
          .where(eq(portfolioSnapshots.userId, user.id))
          .limit(1);
        if (!existing) continue;
      }

      // Full registry, not just this user's positions: the mint list (and so
      // the memoized URL) stays identical across users — one Jupiter call per
      // tick however heterogeneous the portfolios (12 ids ≪ the 50-id cap).
      const marks = await getMarks({
        assets: REGISTRY,
        source: env.PORTFOLIO_MARKS,
        lastTrade: lastTradeMarks(fills.fills),
        fetchImpl: fetchOnce,
      });
      const { holdings, totals } = assembleHoldings({
        positions,
        basis: new Map(), // snapshots record value, not basis
        marks,
        assets: REGISTRY,
      });

      const perAssetJson: Record<string, SnapshotAssetValue> = {};
      for (const h of holdings) {
        perAssetJson[h.assetId] = {
          qty: h.qty,
          markUsd: h.markUsd,
          valueUsd: h.valueUsd,
          ...(h.markStale ? { stale: true } : {}),
        };
      }

      await ctx.db.insert(portfolioSnapshots).values({
        userId: user.id,
        totalUsd: totals.totalUsd,
        perAssetJson,
        at: deps.now(),
      });
      written += 1;
    } catch (err) {
      captureError(err, { source: "snapshot-tick", userId: user.id });
    }
  }

  breadcrumb("snapshots:tick", { scanned: targets.length, written });
  return { scanned: targets.length, written };
}
