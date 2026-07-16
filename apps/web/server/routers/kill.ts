import { randomUUID } from "node:crypto";
import { events, plans, users, type Db } from "@retenix/db";
import { REGISTRY } from "@retenix/registry";
import {
  KILL_EVENTS,
  KILL_RETRYABLE_STATES,
  getMarks,
  isUaTxIdFormat,
  killExecutePayloadSchema,
  killLegFailedReceipt,
  killReportLegPayloadSchema,
  killRetryLegPayloadSchema,
  killStartedPayloadSchema,
  lastTradeMarks,
  planDismissedReceipt,
  revokeAllDigest,
  withSig,
  type KillLegPayload,
  type KillRevokeAuth,
  type KillSkip,
  type KillStartedPayload,
  type KillWorkItem,
} from "@retenix/shared";
import { getPrimaryAssets } from "@retenix/ua";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  allTerminal,
  buildKillReceipt,
  findActiveKill,
  loadKill,
  planKillLegs,
  verifyLegTerminal,
  type KillRows,
  type PrimaryAssetInput,
} from "../lib/kill";
import {
  defaultHoldingsDeps,
  enumeratePositions,
  holdingsCache,
  marksSource,
} from "../lib/holdings";
import { getPlanRelay } from "../lib/relay-factory";
import { serverUa } from "../lib/ua";
import { protectedProcedure, router, signedProcedure } from "../trpc";
import type { Context } from "../context";

/*
 * Kill switch (doc 13, C7 "Liquidate & Lock") — one gesture sells every
 * position to USDC in the user's OWN unified balance and revokes all agent
 * authority. Deliberately LOW friction (TS-14.5): funds can only move to the
 * user's own USDC balance, so the 1.5 s hold is the entire confirmation.
 *
 * The doc-06 pattern, adapted: kill.execute (signed) revokes FIRST and plans
 * the legs; the BROWSER runs them (lib/kill-runner.ts — the key exists only in
 * Magic's session, quotes expire); kill.reportLeg hands claims back which the
 * server re-verifies against its own poll before anything is recorded.
 *
 * Procedure classes are doc 13's verbatim API (signedProcedure /
 * protectedProcedure — NOT the gated variants): the kill switch is the safety
 * surface that must never 403 on gate state. reportLeg is deliberately
 * UNSIGNED (session-authed): per-leg reports fire concurrently and the
 * envelope nonce store is strictly monotonic per user — signing them would
 * make simultaneous reports spuriously reject. It is claims-only by
 * construction: every terminal claim is re-derived server-side (poll, owner
 * match, asset match, txId uniqueness), so a session-only attacker can at
 * worst grief their own legs into a retryable state.
 *
 * Ordering is law: revokeAll relays before execute returns a single work
 * item, so no leg can be sent before authority revocation is in flight. DB
 * plan rows flip inside the creation transaction — the worker's scheduler
 * stops even before the relay send. No code path consults plan state to
 * decide WHETHER to kill (C3's "can never block your kill switch").
 */

const VERIFY = { intervalMs: 1500, timeoutMs: 6000 } as const;

/** A revoke relay attempt younger than this is assumed in flight — a
 *  converging execute must not double-spend the auth nonce. */
const RELAY_ATTEMPT_STALE_MS = 30_000;

type AuthedContext = Context & { session: NonNullable<Context["session"]> };

async function loadUaSolAddr(db: Db, userId: string): Promise<string> {
  const [row] = await db
    .select({ uaSolAddr: users.uaSolAddr })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.uaSolAddr ?? "";
}

/** Broker/guardian cards with live onchain authority. Legacy is NEVER
 *  touched (estate cancellation is its own surface, doc 14). */
async function onchainPlans(db: Db, userId: string) {
  return db
    .select({ id: plans.id, kind: plans.kind, contractPlanId: plans.contractPlanId })
    .from(plans)
    .where(
      and(
        eq(plans.userId, userId),
        ne(plans.kind, "legacy"),
        inArray(plans.status, ["active", "paused"]),
        sql`${plans.contractPlanId} is not null`,
      ),
    );
}

const legStatusView = (l: KillLegPayload) => ({
  legId: l.legId,
  kind: l.kind,
  assetId: l.assetId,
  symbol: l.symbol,
  network: l.network,
  chainId: l.chainId,
  usdEst: l.usdEst,
  outcome: l.outcome,
  attempt: l.attempt,
  transactionId: l.transactionId,
  usd: l.usd,
  fees: l.fees,
  feeSource: l.feeSource,
  error: l.error,
  receipt: l.receipt,
});

const workItem = (l: KillLegPayload): KillWorkItem => ({
  legId: l.legId,
  kind: l.kind,
  assetId: l.assetId,
  symbol: l.symbol,
  chainId: l.chainId,
  token: l.token,
  amountHuman: l.amountHuman,
  expectUsdc: l.expectUsdc,
  primaryType: l.primaryType,
  usdEst: l.usdEst,
});

/** Non-terminal legs, split into what the runner must SEND (pending) and
 *  what it must only RESUME POLLING (submitted — the tx may still land;
 *  re-sending would double-liquidate). */
function splitWork(rows: KillRows) {
  const pending = rows.legs.filter((l) => l.payload.outcome === "pending");
  const submitted = rows.legs.filter(
    (l) => l.payload.outcome === "submitted" && l.payload.transactionId,
  );
  return {
    workItems: pending.map((l) => workItem(l.payload)),
    polling: submitted.map((l) => ({
      legId: l.payload.legId,
      transactionId: l.payload.transactionId as string,
    })),
  };
}

async function updateStartedPayload(
  db: Db,
  eventId: string,
  payload: KillStartedPayload,
): Promise<void> {
  await db
    .update(events)
    .set({ payloadJson: payload })
    .where(eq(events.id, eventId));
}

/**
 * Insert-or-recompute the aggregate kill.receipt inside the caller's locked
 * transaction. Recompute-in-place keeps the counts honest after a
 * post-aggregate retry or a late revoke confirmation (PROPOSED, HANDOFF).
 */
async function upsertAggregate(
  tx: Pick<Db, "execute">,
  userId: string,
  started: KillStartedPayload,
  legs: readonly KillLegPayload[],
): Promise<void> {
  const receipt = buildKillReceipt(started, legs);
  const body = JSON.stringify(receipt);
  const existing = await tx.execute(
    sql`select id from events
        where user_id = ${userId} and type = ${KILL_EVENTS.receipt}
          and payload_json->>'killId' = ${started.killId}
        limit 1`,
  );
  const row = existing.rows[0] as { id: string } | undefined;
  if (row) {
    await tx.execute(
      sql`update events set payload_json = ${body}::jsonb where id = ${row.id}`,
    );
  } else {
    await tx.execute(
      sql`insert into events (user_id, type, payload_json)
          values (${userId}, ${KILL_EVENTS.receipt}, ${body}::jsonb)`,
    );
  }
}

/** Fire the revokeAll relay (send-only) and record the outcome on the
 *  kill.started row. Failure is continue-and-report: the kill proceeds,
 *  revocation stays retryable via a fresh prepare → execute. */
async function relayRevoke(
  db: Db,
  startedEventId: string,
  started: KillStartedPayload,
  owner: string,
  auth: KillRevokeAuth,
): Promise<KillStartedPayload> {
  const relay = getPlanRelay();
  let revoke: KillStartedPayload["revoke"];
  try {
    const { txHash } = await relay.revokeAll({
      owner,
      nonce: BigInt(auth.nonce),
      ownerSig: auth.signature,
    });
    revoke = {
      state: "submitted",
      txHash,
      submittedAtMs: Date.now(),
      relayAttemptAtMs: started.revoke.relayAttemptAtMs,
    };
  } catch (err) {
    revoke = {
      state: "failed",
      error: err instanceof Error ? err.message : "relay unavailable",
      relayAttemptAtMs: started.revoke.relayAttemptAtMs,
    };
  }
  const next = { ...started, revoke };
  await updateStartedPayload(db, startedEventId, next);
  return next;
}

/** Lazy revoke-confirmation read (kill.status): submitted → confirmed/failed
 *  once the chain answers; the aggregate (if written) is recomputed so its
 *  "all agents revoked" clause stays honest. */
async function reconcileRevoke(
  db: Db,
  userId: string,
  rows: KillRows,
): Promise<KillRows> {
  const { started } = rows;
  if (started.revoke.state !== "submitted" || !started.revoke.txHash) return rows;
  let status: "pending" | "confirmed" | "failed";
  try {
    status = await getPlanRelay().txStatus(started.revoke.txHash);
  } catch {
    return rows; // chain unreachable — report last-known truth
  }
  if (status === "pending") return rows;
  const next: KillStartedPayload = {
    ...started,
    revoke: {
      ...started.revoke,
      state: status,
      ...(status === "confirmed" ? { confirmedAtMs: Date.now() } : {}),
    },
  };
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from users where id = ${userId} for update`);
    await tx
      .update(events)
      .set({ payloadJson: next })
      .where(eq(events.id, rows.startedEventId));
    if (rows.receipt) {
      await upsertAggregate(
        tx,
        userId,
        next,
        rows.legs.map((l) => l.payload),
      );
    }
  });
  return { ...rows, started: next };
}

// ---------------------------------------------------------------------------
// execute — the orchestration (tech spec §11 steps, revoke FIRST)
// ---------------------------------------------------------------------------

async function execute(
  ctx: AuthedContext,
  payload: z.infer<typeof killExecutePayloadSchema>,
) {
  const { userId, eoaAddr } = ctx.session;
  const db = ctx.db;
  const relay = getPlanRelay();
  const executeReceivedAtMs = Date.now();

  // Scan phase — ALL network I/O happens before the row lock (a held lock
  // across I/O would stall every signed procedure for this user). Any scan
  // failure aborts BEFORE state changes: nothing happened, the user re-holds.
  const deps = defaultHoldingsDeps();
  const uaSolAddr = await loadUaSolAddr(db, userId);
  let scan;
  try {
    scan = await (async () => {
      const [enumerated, primariesResp, authNonce, livePlans] = await Promise.all([
        enumeratePositions(db, deps, { userId, uaSolAddr }),
        getPrimaryAssets(serverUa(eoaAddr)),
        relay.authNonce(eoaAddr),
        onchainPlans(db, userId),
      ]);
      return { enumerated, primariesResp, authNonce, livePlans };
    })();
  } catch (err) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Couldn't read your positions — nothing was changed. Try again in a moment.",
      cause: err,
    });
  }

  const { enumerated, primariesResp, authNonce, livePlans } = scan;
  const needsRevoke = livePlans.length > 0;

  // Auth validation before ANY write: a stale nonce means the digest the user
  // signed no longer matches the chain — re-prepare, never spend relayer gas
  // on a known BadNonce.
  if (needsRevoke) {
    const auth = payload.revokeAllAuth;
    if (!auth) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "revoke signature required",
      });
    }
    if (BigInt(auth.nonce) !== authNonce) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "authorization expired — re-prepare and sign again",
      });
    }
    if (!relay.verifyRevokeAll(eoaAddr, BigInt(auth.nonce), auth.signature)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "revoke signature does not match this account",
      });
    }
  }

  // Plan the legs (pure). Marks are display estimates; getMarks degrades to
  // last-trade internally and an unpriceable position renders "—".
  const positionAssets = REGISTRY.filter((a) =>
    enumerated.positions.some((p) => p.assetId === a.id),
  );
  const marks = await getMarks({
    assets: positionAssets,
    source: marksSource(),
    lastTrade: lastTradeMarks(enumerated.fills.fills),
    fetchImpl: deps.fetchImpl,
  });
  const primaries = (primariesResp.assets ?? []) as unknown as PrimaryAssetInput[];
  const plan = planKillLegs({
    positions: enumerated.positions,
    primaries,
    marks,
  });

  // Creation (or convergence) under the users-row lock.
  const killId = randomUUID();
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from users where id = ${userId} for update`);

    // Idempotency: one active kill per user — a second execute converges on
    // it (this is also the crash-resume path; never re-enumerate into an
    // active kill: an in-flight leg may still settle).
    const active = await findActiveKill(tx as unknown as Db, userId);
    if (active) return { rows: active, fresh: false };

    const started: KillStartedPayload = {
      killId,
      tapAtMs: payload.tapAtMs,
      holdCompletedAtMs: payload.holdCompletedAtMs,
      executeReceivedAtMs,
      revoke: needsRevoke
        ? { state: "none", relayAttemptAtMs: Date.now() }
        : { state: "confirmed" }, // nothing to revoke — no authority existed
      planIds: livePlans.map((p) => p.id),
      skipped: plan.skipped as KillSkip[],
      legCount: plan.legs.length,
    };
    const legPayloads: KillLegPayload[] = plan.legs.map((leg) => ({
      ...leg,
      killId,
      legId: randomUUID(),
      outcome: "pending",
      attempt: 1,
    }));

    const [startedRow] = await tx
      .insert(events)
      .values({ userId, type: KILL_EVENTS.started, payloadJson: started })
      .returning({ id: events.id });
    const legRows: KillRows["legs"] = [];
    for (const legPayload of legPayloads) {
      const [row] = await tx
        .insert(events)
        .values({ userId, type: KILL_EVENTS.leg, payloadJson: legPayload })
        .returning({ id: events.id });
      legRows.push({ eventId: row.id, payload: legPayload });
    }

    // Authority dies fastest: DB statuses flip INSIDE this transaction (the
    // worker's scheduler gates on status === "active", so scheduling stops
    // even before the relay send lands). Legacy untouched by design.
    if (livePlans.length > 0) {
      await tx
        .update(plans)
        .set({ status: "revoked" })
        .where(
          inArray(
            plans.id,
            livePlans.map((p) => p.id),
          ),
        );
      await tx.insert(events).values(
        livePlans.map((p) => ({
          userId,
          type: "plan.revoked",
          payloadJson: {
            planId: p.id,
            contractPlanId: p.contractPlanId,
            receipt: planDismissedReceipt(p.kind),
          },
        })),
      );
    }

    return {
      rows: {
        startedEventId: startedRow.id,
        started,
        legs: legRows,
        receipt: undefined,
      } satisfies KillRows,
      fresh: true,
    };
  });

  let rows = created.rows;

  // Revoke relay — FIRST, before a single work item is returned. Send-only;
  // failure is continue-and-report (the legs still run; funds can only reach
  // the user's own USDC balance, revocation stays retryable).
  const revokeState = rows.started.revoke;
  const shouldRelay =
    created.fresh
      ? needsRevoke
      : payload.revokeAllAuth !== undefined &&
        (revokeState.state === "failed" ||
          (revokeState.state === "none" &&
            (revokeState.relayAttemptAtMs === undefined ||
              Date.now() - revokeState.relayAttemptAtMs > RELAY_ATTEMPT_STALE_MS)));
  if (shouldRelay && payload.revokeAllAuth) {
    const started = await relayRevoke(
      db,
      rows.startedEventId,
      rows.started,
      eoaAddr,
      payload.revokeAllAuth,
    );
    rows = { ...rows, started };
  }

  // Zero-leg kill (all-USDC account): the receipt is written in the same flow
  // or it would linger "active" forever with nothing to report it done.
  if (created.fresh && rows.legs.length === 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select id from users where id = ${userId} for update`);
      await upsertAggregate(tx, userId, rows.started, []);
    });
  }

  const { workItems, polling } = splitWork(rows);
  return {
    killId: rows.started.killId,
    resumed: !created.fresh,
    revoke: {
      state: rows.started.revoke.state,
      txHash: rows.started.revoke.txHash,
    },
    workItems,
    polling,
    skipped: rows.started.skipped,
  };
}

// ---------------------------------------------------------------------------
// reportLeg — claims in, server-verified truth out
// ---------------------------------------------------------------------------

async function reportLeg(
  ctx: AuthedContext,
  payload: z.infer<typeof killReportLegPayloadSchema>,
) {
  const { userId, eoaAddr } = ctx.session;
  const db = ctx.db;

  const rows = await loadKill(db, userId, payload.killId);
  if (!rows) throw new TRPCError({ code: "NOT_FOUND", message: "unknown kill" });
  const leg = rows.legs.find((l) => l.payload.legId === payload.legId);
  if (!leg) throw new TRPCError({ code: "NOT_FOUND", message: "unknown leg" });

  // --- submitted claim: stamp the id + the AC1 mark -------------------------
  if (payload.phase === "submitted") {
    if (!payload.transactionId || !isUaTxIdFormat(payload.transactionId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "transaction id required" });
    }
    const transactionId = payload.transactionId;
    return db.transaction(async (tx) => {
      await tx.execute(sql`select id from users where id = ${userId} for update`);
      const fresh = await reloadLeg(tx, userId, payload.killId, payload.legId);
      if (fresh.payload.outcome === "submitted" && fresh.payload.transactionId === transactionId) {
        return { outcome: fresh.payload.outcome }; // idempotent converge
      }
      if (fresh.payload.outcome !== "pending") {
        return { outcome: fresh.payload.outcome }; // terminal already — claims never regress
      }
      await assertTxIdUnbound(tx, userId, transactionId, payload.legId);
      const next: KillLegPayload = {
        ...fresh.payload,
        outcome: "submitted",
        transactionId,
        submittedAtMs: Date.now(),
        attempt: fresh.payload.attempt,
        ...(payload.feesQuoted ? { fees: payload.feesQuoted, feeSource: "quoted" as const } : {}),
      };
      await tx.update(events).set({ payloadJson: next }).where(eq(events.id, fresh.eventId));
      return { outcome: next.outcome };
    });
  }

  // --- failed claim: a leg that never got a transaction sent ---------------
  if (payload.phase === "failed") {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select id from users where id = ${userId} for update`);
      const fresh = await reloadLeg(tx, userId, payload.killId, payload.legId);
      if (fresh.payload.outcome !== "pending") {
        // A submitted leg's tx may still land — a client-side "failed" claim
        // never overrides it; terminal states never regress.
        return { outcome: fresh.payload.outcome };
      }
      const next: KillLegPayload = {
        ...fresh.payload,
        outcome: "failed",
        error: payload.error ?? "didn't send",
        receipt: killLegFailedReceipt(fresh.payload.symbol),
      };
      await tx.update(events).set({ payloadJson: next }).where(eq(events.id, fresh.eventId));
      await maybeAggregate(tx, userId, rows, fresh.eventId, next);
      return { outcome: next.outcome };
    });
  }

  // --- terminal claim: re-derive truth from the server's own poll ----------
  const transactionId = payload.transactionId ?? leg.payload.transactionId;
  if (!transactionId || !isUaTxIdFormat(transactionId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "transaction id required" });
  }
  if (leg.payload.outcome !== "pending" && leg.payload.outcome !== "submitted") {
    return { outcome: leg.payload.outcome }; // already terminal — converge
  }

  const verification = await verifyLegTerminal(
    { ua: serverUa(eoaAddr) },
    leg.payload,
    transactionId,
    { eoaAddr, uaSolAddr: await loadUaSolAddr(db, userId) },
    payload.feesQuoted,
  );
  if (verification.kind === "still-settling") {
    throw new TRPCError({ code: "CONFLICT", message: "still settling" });
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from users where id = ${userId} for update`);
    const fresh = await reloadLeg(tx, userId, payload.killId, payload.legId);
    if (fresh.payload.outcome !== "pending" && fresh.payload.outcome !== "submitted") {
      return { outcome: fresh.payload.outcome, settledNow: false };
    }
    if (fresh.payload.transactionId !== transactionId) {
      await assertTxIdUnbound(tx, userId, transactionId, payload.legId);
    }
    const next: KillLegPayload = {
      ...fresh.payload,
      ...verification.patch,
      outcome: verification.state,
    };
    await tx.update(events).set({ payloadJson: next }).where(eq(events.id, fresh.eventId));
    await maybeAggregate(tx, userId, rows, fresh.eventId, next);
    return { outcome: next.outcome, settledNow: verification.state === "settled" };
  });

  // A settled sell changes positions/basis — the next holdings read recomputes.
  if (result.settledNow) holdingsCache.drop(userId);
  return { outcome: result.outcome };
}

/** Re-read one leg inside the locked transaction (claims race each other). */
async function reloadLeg(
  tx: Pick<Db, "execute">,
  userId: string,
  killId: string,
  legId: string,
): Promise<{ eventId: string; payload: KillLegPayload }> {
  const res = await tx.execute(
    sql`select id, payload_json from events
        where user_id = ${userId} and type = ${KILL_EVENTS.leg}
          and payload_json->>'killId' = ${killId}
          and payload_json->>'legId' = ${legId}
        limit 1`,
  );
  const row = res.rows[0] as { id: string; payload_json: KillLegPayload } | undefined;
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "unknown leg" });
  return { eventId: row.id, payload: row.payload_json };
}

/** A transactionId may bind to exactly ONE ledger-bearing row — else a
 *  session-only attacker could mint phantom sell fills from one real tx. */
async function assertTxIdUnbound(
  tx: Pick<Db, "execute">,
  userId: string,
  transactionId: string,
  legId: string,
): Promise<void> {
  const res = await tx.execute(
    sql`select 1 from events
        where user_id = ${userId}
          and type in (${KILL_EVENTS.leg}, 'sell.receipt')
          and payload_json->>'transactionId' = ${transactionId}
          and coalesce(payload_json->>'legId', '') <> ${legId}
        limit 1`,
  );
  if (res.rows.length > 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "that transaction is already recorded",
    });
  }
}

/** After a terminal transition: if every leg is terminal, write (or
 *  recompute) the aggregate — inside the caller's locked transaction, so
 *  concurrent last-leg reports serialize and exactly one row exists. */
async function maybeAggregate(
  tx: Pick<Db, "execute">,
  userId: string,
  rows: KillRows,
  changedEventId: string,
  changedPayload: KillLegPayload,
): Promise<void> {
  const currentRes = await tx.execute(
    sql`select id, payload_json from events
        where user_id = ${userId} and type = ${KILL_EVENTS.leg}
          and payload_json->>'killId' = ${rows.started.killId}`,
  );
  const legs = (currentRes.rows as { id: string; payload_json: KillLegPayload }[]).map(
    (row) => (row.id === changedEventId ? changedPayload : row.payload_json),
  );
  if (!allTerminal(legs.map((p) => ({ payload: p })))) return;

  // The started row may have advanced (revoke confirmation) — re-read it.
  const startedRes = await tx.execute(
    sql`select payload_json from events
        where user_id = ${userId} and type = ${KILL_EVENTS.started}
          and payload_json->>'killId' = ${rows.started.killId}
        limit 1`,
  );
  const startedRow = startedRes.rows[0] as { payload_json: unknown } | undefined;
  const started = startedRow
    ? killStartedPayloadSchema.parse(startedRow.payload_json)
    : rows.started;
  await upsertAggregate(tx, userId, started, legs);
}

// ---------------------------------------------------------------------------
// retryLeg — re-arm without re-arming the hold (PS-F6-AC2)
// ---------------------------------------------------------------------------

async function retryLeg(
  ctx: AuthedContext,
  payload: z.infer<typeof killRetryLegPayloadSchema>,
) {
  const { userId, eoaAddr } = ctx.session;
  const db = ctx.db;

  const rows = await loadKill(db, userId, payload.killId);
  if (!rows) throw new TRPCError({ code: "NOT_FOUND", message: "unknown kill" });
  const leg = rows.legs.find((l) => l.payload.legId === payload.legId);
  if (!leg) throw new TRPCError({ code: "NOT_FOUND", message: "unknown leg" });

  const current = leg.payload;

  if (current.outcome === "settled") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "already completed — nothing to retry",
    });
  }

  // A crash-before-send leg: the original work item is still valid.
  if (current.outcome === "pending") {
    return { workItem: workItem(current), attempt: current.attempt };
  }

  // A submitted leg is never blindly re-armed — its tx may still land, and a
  // re-sell of the same position would double-liquidate. Verify first.
  if (current.outcome === "submitted") {
    if (!current.transactionId) {
      // Submitted without an id cannot happen through reportLeg; recover by
      // re-arming (nothing verifiable is in flight).
    } else {
      const verification = await verifyLegTerminal(
        { ua: serverUa(eoaAddr) },
        current,
        current.transactionId,
        { eoaAddr, uaSolAddr: await loadUaSolAddr(db, userId) },
      );
      if (verification.kind === "still-settling") {
        throw new TRPCError({ code: "CONFLICT", message: "still settling" });
      }
      if (verification.state === "settled") {
        // Apply the truth, no re-arm.
        await db.transaction(async (tx) => {
          await tx.execute(sql`select id from users where id = ${userId} for update`);
          const fresh = await reloadLeg(tx, userId, payload.killId, payload.legId);
          if (fresh.payload.outcome === "submitted") {
            const next: KillLegPayload = {
              ...fresh.payload,
              ...verification.patch,
              outcome: "settled",
            };
            await tx.update(events).set({ payloadJson: next }).where(eq(events.id, fresh.eventId));
            await maybeAggregate(tx, userId, rows, fresh.eventId, next);
          }
        });
        holdingsCache.drop(userId);
        throw new TRPCError({
          code: "CONFLICT",
          message: "already completed — nothing to retry",
        });
      }
      // terminal-failed/refunded/unverified: fall through to the re-arm below.
    }
  }

  // failed / refunded / unverified (or verified-just-now): position still
  // held → re-arm. Retryable forever without a new hold.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from users where id = ${userId} for update`);
    const fresh = await reloadLeg(tx, userId, payload.killId, payload.legId);
    const rearmable =
      (KILL_RETRYABLE_STATES as readonly string[]).includes(fresh.payload.outcome) ||
      fresh.payload.outcome === "submitted"; // verified terminal-failed above
    if (fresh.payload.outcome === "pending") {
      return { workItem: workItem(fresh.payload), attempt: fresh.payload.attempt };
    }
    if (!rearmable) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "already completed — nothing to retry",
      });
    }
    const next: KillLegPayload = {
      ...fresh.payload,
      outcome: "pending",
      attempt: fresh.payload.attempt + 1,
      transactionId: undefined,
      submittedAtMs: undefined,
      qty: undefined,
      usd: undefined,
      fees: undefined,
      feeSource: undefined,
      serverVerified: undefined,
      error: undefined,
      receipt: undefined,
    };
    await tx.update(events).set({ payloadJson: next }).where(eq(events.id, fresh.eventId));
    return { workItem: workItem(next), attempt: next.attempt };
  });
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export const killRouter = router({
  /** PROPOSED helper (the plans.prepareRevoke precedent): the revokeAll
   *  digest + authoritative nonce the owner personal_signs headlessly, plus
   *  resume state for a re-opened surface. */
  prepare: protectedProcedure.query(async ({ ctx }) => {
    const { userId, eoaAddr } = ctx.session;
    const [live, active, latest] = await Promise.all([
      onchainPlans(ctx.db, userId),
      findActiveKill(ctx.db, userId),
      loadKill(ctx.db, userId),
    ]);
    const needsRevoke = live.length > 0;
    let digest: string | null = null;
    let nonce: string | null = null;
    if (needsRevoke) {
      const relay = getPlanRelay();
      const n = await relay.authNonce(eoaAddr);
      digest = revokeAllDigest(relay.domain, { nonce: n });
      nonce = n.toString();
    }
    return {
      needsRevoke,
      digest,
      nonce,
      activeKillId: active?.started.killId ?? null,
      lastKillId: latest?.started.killId ?? null,
    };
  }),

  execute: signedProcedure
    .input(withSig(killExecutePayloadSchema))
    .mutation(async ({ ctx, input }) =>
      execute(ctx, killExecutePayloadSchema.parse(input.payload)),
    ),

  status: protectedProcedure
    .input(z.object({ killId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const { userId } = ctx.session;
      let rows = await loadKill(ctx.db, userId, input.killId);
      if (!rows) throw new TRPCError({ code: "NOT_FOUND", message: "unknown kill" });
      rows = await reconcileRevoke(ctx.db, userId, rows);
      const legs = rows.legs.map((l) => legStatusView(l.payload));
      return {
        killId: rows.started.killId,
        legs,
        revoked: rows.started.revoke.state === "confirmed",
        revoke: {
          state: rows.started.revoke.state,
          txHash: rows.started.revoke.txHash,
        },
        skipped: rows.started.skipped,
        receipt: rows.receipt?.payload.receipt ?? null,
        done: rows.receipt !== undefined,
        marks: {
          tapAtMs: rows.started.tapAtMs ?? null,
          holdCompletedAtMs: rows.started.holdCompletedAtMs ?? null,
          lastSubmittedAtMs: rows.legs.reduce<number | null>(
            (max, l) =>
              l.payload.submittedAtMs !== undefined &&
              (max === null || l.payload.submittedAtMs > max)
                ? l.payload.submittedAtMs
                : max,
            null,
          ),
        },
      };
    }),

  /** Claims-only per-leg reporting — see the header comment for why this is
   *  session-authed rather than envelope-signed. */
  reportLeg: protectedProcedure
    .input(killReportLegPayloadSchema)
    .mutation(async ({ ctx, input }) => reportLeg(ctx, input)),

  retryLeg: signedProcedure
    .input(withSig(killRetryLegPayloadSchema))
    .mutation(async ({ ctx, input }) =>
      retryLeg(ctx, killRetryLegPayloadSchema.parse(input.payload)),
    ),
});
