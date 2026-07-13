import { randomUUID } from "node:crypto";
import { events, users, type Db } from "@retenix/db";
import {
  SWEEP_EVENTS,
  networkName,
  sweepExecutePayloadSchema,
  sweepReceiptHeadline,
  withSig,
  type FeeTotals,
  type SweepLegReport,
  type SweepReceipt,
  type SweepReceiptLeg,
} from "@retenix/shared";
import {
  SUPPORTED_TOKEN_TYPE,
  activityUrl,
  createSellTransaction,
  parseFeeTotals,
  pollToTerminal,
  type ITradeConfig,
  type UaTransaction,
} from "@retenix/ua";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import {
  defaultDustDeps,
  scanDust,
  type DustItem,
  type DustScanResult,
} from "../lib/dust";
import { serverUa } from "../lib/ua";
import { gatedProcedure, gatedSignedProcedure, router } from "../trpc";
import type { Context } from "../context";

/*
 * Dust sweep (doc 06) — scattered value on N networks becomes USDC buying
 * power in ONE user confirmation with ONE honest aggregate receipt.
 *
 * The "one confirmation, N headless signatures" pattern (docs 13/15 reuse it):
 * the user's single visible act is the ConfirmSheet tap. That tap fires
 * sweep.execute phase "authorize" (a signed envelope — headless personal_sign
 * via Magic); the browser then runs the legs itself (lib/sweep-runner.ts:
 * createSellTransaction → signAndSend(magicSigner) per item, sequentially,
 * no further UI — the user's key exists only in the browser's Magic session,
 * and quotes expire, so legs can never run server-side); finally phase
 * "report" (another headless envelope) hands the outcomes back and the server
 * writes the receipt.
 *
 * Trust boundaries:
 *   • The item list is SERVER-derived in "authorize" (a client-supplied list
 *     would be a forced-swap primitive) and pinned in a sweep.authorized event.
 *   • "report" treats everything client-sent as claims: legs are matched to
 *     the authorized items (usd/symbol always from the server's own scan),
 *     transactionIds are re-polled against Particle, and unmatched legs are
 *     recorded under `ignored`, never counted.
 *   • Exactly ONE sweep.receipt event per execution — written under the same
 *     users-row lock the nonce store uses; a duplicate report converges on the
 *     existing receipt instead of erroring.
 */

/** Sells settle ONLY into USDC in the user's own UA (doc 06 hard constraint). */
const SELL_TO_USDC: ITradeConfig = {
  usePrimaryTokens: [SUPPORTED_TOKEN_TYPE.USDC],
};

/** An un-receipted authorization younger than this blocks a new one. */
const AUTHORIZE_STALE_MS = 10 * 60_000;

/** Legs are already terminal when reported — verification is one quick poll,
 *  never the 180s default (the route has a 60s serverless ceiling). */
const VERIFY_POLL = { intervalMs: 1500, timeoutMs: 6000 };

const itemKey = (chainId: number, token: string) =>
  `${chainId}:${token.toLowerCase()}`;

async function loadUaSolAddr(db: Db, userId: string): Promise<string> {
  const [row] = await db
    .select({ uaSolAddr: users.uaSolAddr })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.uaSolAddr ?? "";
}

/** One scan+quote pipeline shared by preview and authorize — the authorize
 *  re-scan is what makes the client's preview list untrusted by construction. */
async function runScan(ctx: {
  db: Db;
  session: { userId: string; eoaAddr: string };
}): Promise<DustScanResult> {
  const ua = serverUa(ctx.session.eoaAddr);
  const deps = defaultDustDeps(({ chainId, token, amountHuman }) =>
    createSellTransaction(
      ua,
      { token: { chainId, address: token }, amount: amountHuman },
      SELL_TO_USDC,
    ).then(parseFeeTotals),
  );
  return scanDust(
    {
      eoaAddr: ctx.session.eoaAddr,
      uaSolAddr: await loadUaSolAddr(ctx.db, ctx.session.userId),
    },
    deps,
  );
}

async function hasEvent(
  db: Db,
  userId: string,
  type: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.type, type)))
    .limit(1);
  return !!row;
}

type DbOrTx = Pick<Db, "execute">;

async function findReceipt(
  db: DbOrTx,
  userId: string,
  executionId: string,
): Promise<SweepReceipt | null> {
  const res = await db.execute(
    sql`select payload_json from events
        where user_id = ${userId} and type = ${SWEEP_EVENTS.receipt}
          and payload_json->>'executionId' = ${executionId}
        limit 1`,
  );
  const row = res.rows[0] as { payload_json: SweepReceipt } | undefined;
  return row?.payload_json ?? null;
}

// ---------------------------------------------------------------------------
// Phase 1 — authorize
// ---------------------------------------------------------------------------

export interface SweepAuthorization {
  /** null = nothing worth sweeping right now (no authorization recorded). */
  executionId: string | null;
  items: DustItem[];
  totalUsd: number;
  fees: FeeTotals;
  skipped: DustScanResult["skipped"];
}

async function authorize(ctx: Context & { session: NonNullable<Context["session"]> }): Promise<SweepAuthorization> {
  const { userId } = ctx.session;
  const scan = await runScan(ctx);

  if (scan.items.length === 0) {
    return {
      executionId: null,
      items: [],
      totalUsd: 0,
      fees: scan.fees,
      skipped: scan.skipped,
    };
  }

  const executionId = randomUUID();
  await ctx.db.transaction(async (tx) => {
    // Same row lock the nonce store uses — authorizations serialize per user.
    await tx.execute(sql`select id from users where id = ${userId} for update`);

    // Double-tap guard: a recent authorization that never produced a receipt
    // means a sweep is (or may still be) running in another tab.
    const staleCutoff = new Date(Date.now() - AUTHORIZE_STALE_MS);
    const recent = await tx.execute(
      sql`select payload_json->>'executionId' as execution_id
          from events
          where user_id = ${userId} and type = ${SWEEP_EVENTS.authorized}
            and created_at > ${staleCutoff}
          order by created_at desc`,
    );
    for (const row of recent.rows as { execution_id: string }[]) {
      const receipted = await tx.execute(
        sql`select 1 from events
            where user_id = ${userId} and type = ${SWEEP_EVENTS.receipt}
              and payload_json->>'executionId' = ${row.execution_id}
            limit 1`,
      );
      if (receipted.rows.length === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "a sweep is already in progress",
        });
      }
    }

    await tx.insert(events).values({
      userId,
      type: SWEEP_EVENTS.authorized,
      payloadJson: {
        executionId,
        totalUsd: scan.totalUsd,
        fees: scan.fees,
        items: scan.items,
        skipped: scan.skipped,
      },
    });
  });

  return {
    executionId,
    items: scan.items,
    totalUsd: scan.totalUsd,
    fees: scan.fees,
    skipped: scan.skipped,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — report → THE receipt
// ---------------------------------------------------------------------------

type LegVerification =
  | { kind: "none" } // client never got a transactionId for this leg
  | { kind: "polled"; outcome: "finished" | "refunded" | "timeout"; t: UaTransaction }
  | { kind: "lookup-failed" }; // Particle couldn't answer — verification impossible

async function verifyLeg(
  eoaAddr: string,
  transactionId: string | undefined,
): Promise<LegVerification> {
  if (!transactionId) return { kind: "none" };
  try {
    const result = await pollToTerminal(serverUa(eoaAddr), transactionId, VERIFY_POLL);
    return { kind: "polled", outcome: result.outcome, t: result.t };
  } catch {
    return { kind: "lookup-failed" };
  }
}

/** Best-effort owner extraction from the (unfrozen, doc 03 OQ5) polled payload. */
function extractOwners(t: UaTransaction): string[] {
  const owners: string[] = [];
  const sao = t.smartAccountOptions as { ownerAddress?: unknown } | undefined;
  if (typeof sao?.ownerAddress === "string") owners.push(sao.ownerAddress);
  if (typeof t.sender === "string" && t.sender) owners.push(t.sender);
  return owners;
}

const ZERO_FEES: FeeTotals = { gas: 0, service: 0, lp: 0, total: 0 };

async function report(
  ctx: Context & { session: NonNullable<Context["session"]> },
  payload: { executionId: string; legs: SweepLegReport[] },
): Promise<SweepReceipt> {
  const { userId, eoaAddr } = ctx.session;

  const authRes = await ctx.db.execute(
    sql`select payload_json from events
        where user_id = ${userId} and type = ${SWEEP_EVENTS.authorized}
          and payload_json->>'executionId' = ${payload.executionId}
        limit 1`,
  );
  const authRow = authRes.rows[0] as
    | { payload_json: { executionId: string; totalUsd: number; items: DustItem[] } }
    | undefined;
  if (!authRow) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "unknown or unauthorized execution",
    });
  }
  const auth = authRow.payload_json;

  // Fast idempotency path (the exactly-once guarantee is the locked write below).
  const existing = await findReceipt(ctx.db, userId, payload.executionId);
  if (existing) return existing;

  // Match reported legs to the AUTHORIZED items — the server's own scan is the
  // only source of what a leg was worth.
  const itemByKey = new Map(auth.items.map((i) => [itemKey(i.chainId, i.token), i]));
  const seen = new Set<string>();
  const matched: { item: DustItem; leg: (typeof payload.legs)[number] }[] = [];
  const ignored: SweepReceipt["ignored"] = [];
  for (const leg of payload.legs) {
    const k = itemKey(leg.chainId, leg.token);
    const item = itemByKey.get(k);
    if (!item) {
      ignored.push({ chainId: leg.chainId, token: leg.token, reason: "unauthorized" });
      continue;
    }
    if (seen.has(k)) {
      ignored.push({ chainId: leg.chainId, token: leg.token, reason: "duplicate" });
      continue;
    }
    seen.add(k);
    matched.push({ item, leg });
  }

  // The user's Solana UA may legitimately appear as a leg's sender.
  const uaSolAddr = await loadUaSolAddr(ctx.db, userId);
  const ownAddresses = new Set(
    [eoaAddr, uaSolAddr].filter(Boolean).map((a) => a.toLowerCase()),
  );

  const verifications = await Promise.all(
    matched.map(({ leg }) => verifyLeg(eoaAddr, leg.transactionId)),
  );

  const legs: SweepReceiptLeg[] = matched.map(({ item, leg }, i) => {
    const v = verifications[i];

    let outcome: SweepReceiptLeg["outcome"];
    let serverVerified: boolean;
    let error = leg.error;

    if (v.kind === "none") {
      outcome = "failed";
      serverVerified = false;
    } else if (v.kind === "polled") {
      const owners = extractOwners(v.t);
      const foreign =
        owners.length > 0 && !owners.some((o) => ownAddresses.has(o.toLowerCase()));
      if (foreign) {
        // The transaction exists but is not this account's — never counted.
        outcome = "failed";
        serverVerified = true;
        error = "did not match this account";
      } else if (v.outcome === "finished") {
        outcome = "finished";
        serverVerified = true;
      } else if (v.outcome === "refunded") {
        // REFUND terminal (8–11): failed-with-refund — receipt it honestly.
        outcome = "refunded";
        serverVerified = true;
        error ??= "returned";
      } else {
        // Still not terminal after the verify window — never counted.
        outcome = "unverified";
        serverVerified = false;
      }
    } else {
      // Verification impossible (lookup failed). Carry the client's claim,
      // flagged — headline exposure stays bounded by the authorized USD.
      serverVerified = false;
      outcome =
        leg.clientOutcome === "finished"
          ? "finished"
          : leg.clientOutcome === "refunded"
            ? "refunded"
            : "failed";
    }

    // Fees: prefer a server-side parse when the polled payload carries
    // feeQuotes in the known shape; otherwise the client's create-time quote
    // (the sanctioned parseFeeTotals output) is the honest source.
    let fees = leg.feesQuoted ?? ZERO_FEES;
    let feeSource: SweepReceiptLeg["feeSource"] = leg.feesQuoted ? "quoted" : "none";
    if (v.kind === "polled" && Array.isArray(v.t.feeQuotes)) {
      try {
        fees = parseFeeTotals({ feeQuotes: v.t.feeQuotes });
        feeSource = "settled";
      } catch {
        // keep the quoted fees
      }
    }

    return {
      chainId: item.chainId,
      network: networkName(item.chainId),
      token: item.token,
      symbol: item.symbol,
      usd: item.usd,
      transactionId: leg.transactionId,
      outcome,
      serverVerified,
      fees,
      feeSource,
      activityUrl: leg.transactionId ? activityUrl(leg.transactionId) : undefined,
      error,
    };
  });

  // Authorized items the client never reported: honest "not attempted" rows —
  // still dust, the next preview finds them again.
  for (const item of auth.items) {
    if (seen.has(itemKey(item.chainId, item.token))) continue;
    legs.push({
      chainId: item.chainId,
      network: networkName(item.chainId),
      token: item.token,
      symbol: item.symbol,
      usd: item.usd,
      outcome: "failed",
      serverVerified: true,
      fees: ZERO_FEES,
      feeSource: "none",
      error: "not attempted",
    });
  }

  const counted = legs.filter((l) => l.outcome === "finished");
  const succeededUsd = counted.reduce((sum, l) => sum + l.usd, 0);
  const networkCount = new Set(counted.map((l) => l.chainId)).size;
  const receipt: SweepReceipt = {
    executionId: payload.executionId,
    headline: sweepReceiptHeadline(succeededUsd, networkCount),
    succeededUsd,
    networkCount,
    authorizedTotalUsd: auth.totalUsd,
    fees: counted.reduce(
      (sum, l) => ({
        gas: sum.gas + l.fees.gas,
        service: sum.service + l.fees.service,
        lp: sum.lp + l.fees.lp,
        total: sum.total + l.fees.total,
      }),
      ZERO_FEES,
    ),
    legs,
    ignored,
    createdAt: new Date().toISOString(),
  };

  // Exactly-once write, serialized on the users row (the consumeNonce shape).
  return await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select id from users where id = ${userId} for update`);
    const raced = await findReceipt(tx, userId, payload.executionId);
    if (raced) return raced; // a concurrent report won — converge on its receipt
    await tx.insert(events).values({
      userId,
      type: SWEEP_EVENTS.receipt,
      payloadJson: receipt,
    });
    return receipt;
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const sweepRouter = router({
  // Asset route → behind the eligibility gate (module 04's doctrine), like
  // account.summary. Returns the spec shape plus the prompt-card state.
  preview: gatedProcedure.query(async ({ ctx }) => {
    const scan = await runScan(ctx);
    const [hasSwept, dismissed] = await Promise.all([
      hasEvent(ctx.db, ctx.session.userId, SWEEP_EVENTS.receipt),
      hasEvent(ctx.db, ctx.session.userId, SWEEP_EVENTS.dismissed),
    ]);
    return {
      totalUsd: scan.totalUsd,
      items: scan.items.map(({ chainId, token, symbol, usd }) => ({
        chainId,
        token,
        symbol,
        usd,
      })),
      skipped: scan.skipped,
      fees: scan.fees,
      hasSwept,
      dismissed,
    };
  }),

  execute: gatedSignedProcedure
    .input(withSig(sweepExecutePayloadSchema))
    .mutation(async ({ ctx, input }) => {
      const payload = input.payload;
      if (payload.phase === "authorize") {
        return { phase: "authorize" as const, authorization: await authorize(ctx) };
      }
      return { phase: "report" as const, receipt: await report(ctx, payload) };
    }),

  // The prompt is an offer; silence does nothing, and a dismissal is
  // remembered per user (events type sweep.dismissed). Idempotent.
  dismiss: gatedProcedure.mutation(async ({ ctx }) => {
    const already = await hasEvent(ctx.db, ctx.session.userId, SWEEP_EVENTS.dismissed);
    if (!already) {
      await ctx.db.insert(events).values({
        userId: ctx.session.userId,
        type: SWEEP_EVENTS.dismissed,
        payloadJson: {},
      });
    }
    return { dismissed: true };
  }),
});
