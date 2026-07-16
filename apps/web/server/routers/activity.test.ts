import { randomUUID } from "node:crypto";
import { events, executions, getDb, jobs, plans, users } from "@retenix/db";
import {
  blockedReceipt,
  brokerHiredReceipt,
  executedReceipt,
  killLegSoldReceipt,
  killReceiptText,
  refundedReceipt,
  sweepReceiptHeadline,
} from "@retenix/shared";
import { TRPCError } from "@trpc/server";
import { inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../context";
import type { FeedFilter } from "./activity";

const { appRouter } = await import("./index");
const db = getDb();

const createdUsers: string[] = [];

function hex(len: number): string {
  let s = "";
  while (s.length < len) s += Math.floor(Math.random() * 16).toString(16);
  return s.slice(0, len);
}

async function makeUser(region = "DE"): Promise<string> {
  const suffix = hex(8);
  const [row] = await db
    .insert(users)
    .values({
      emailHash: `0xtest${suffix}${"0".repeat(53)}`,
      eoaAddr: `0xfeed${suffix}${"0".repeat(28)}`,
      uaEvmAddr: "",
      uaSolAddr: "",
      region,
    })
    .returning({ id: users.id });
  createdUsers.push(row.id);
  return row.id;
}

function ctxFor(userId: string): Context {
  return {
    db,
    session: {
      userId,
      eoaAddr: "0xfeed",
      issuer: "did:test:feed",
      region: "DE",
    },
    headers: new Headers(),
    resHeaders: new Headers(),
  } as Context;
}

const caller = (userId: string) => appRouter.createCaller(ctxFor(userId));

async function seedPlan(
  userId: string,
  kind: "broker" | "guardian" | "legacy" = "broker",
): Promise<string> {
  const [row] = await db
    .insert(plans)
    .values({ userId, kind, paramsJson: {}, status: "active" })
    .returning({ id: plans.id });
  return row.id;
}

async function seedJob(planId: string): Promise<string> {
  const [row] = await db
    .insert(jobs)
    .values({
      planId,
      runAt: new Date(),
      periodKey: `${planId}:test:${randomUUID()}`,
      status: "done",
    })
    .returning({ id: jobs.id });
  return row.id;
}

interface ExecSeed {
  status: "quoted" | "recorded" | "submitted" | "finished" | "refunded" | "blocked" | "failed";
  receiptText: string;
  createdAt: Date;
  uaTxId?: string | null;
  feesJson?: unknown;
  quoteJson?: unknown;
}

async function seedExecution(jobId: string, seed: ExecSeed): Promise<string> {
  const [row] = await db
    .insert(executions)
    .values({
      jobId,
      status: seed.status,
      receiptText: seed.receiptText,
      createdAt: seed.createdAt,
      uaTxId: seed.uaTxId ?? null,
      feesJson: seed.feesJson ?? null,
      quoteJson: seed.quoteJson ?? null,
    })
    .returning({ id: executions.id });
  return row.id;
}

async function seedEvent(
  userId: string,
  type: string,
  payload: unknown,
  createdAt: Date,
): Promise<string> {
  const [row] = await db
    .insert(events)
    .values({ userId, type, payloadJson: payload, createdAt })
    .returning({ id: events.id });
  return row.id;
}

/** Walk the feed to exhaustion; guards against cursor loops. */
async function walk(userId: string, filter: FeedFilter) {
  const items = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await caller(userId).activity.feed({ cursor, filter });
    items.push(...page.items);
    if (!page.nextCursor) return { items, pages: i + 1 };
    cursor = page.nextCursor;
  }
  throw new Error("cursor never terminated");
}

/** ms-distinct timestamps, newest first at i=0. */
const at = (i: number, base = Date.parse("2026-07-16T12:00:00.000Z")) =>
  new Date(base - i * 1_000);

const FEES = { gas: 0.03, service: 0.08, lp: 0.03, total: 0.14 };
const EXECUTED = executedReceipt({
  usd: 15,
  ticker: "SPYx",
  sources: ["Base", "Arbitrum"],
  fees: FEES,
});
const BLOCKED = blockedReceipt("OverPeriodCap", "$50 weekly cap");
const REFUNDED = refundedReceipt(15);

afterEach(async () => {
  if (createdUsers.length === 0) return;
  // FK order: executions → jobs → plans → events → users
  const planIds = db
    .select({ id: plans.id })
    .from(plans)
    .where(inArray(plans.userId, createdUsers));
  const jobIds = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(inArray(jobs.planId, planIds));
  await db.delete(executions).where(inArray(executions.jobId, jobIds));
  await db.delete(jobs).where(inArray(jobs.planId, planIds));
  await db.delete(plans).where(inArray(plans.userId, createdUsers));
  await db.delete(events).where(inArray(events.userId, createdUsers));
  await db.delete(users).where(inArray(users.id, createdUsers));
  createdUsers.length = 0;
});

describe("activity.feed", () => {
  it("unions executions and events, newest first, with byte-verbatim sentences", async () => {
    const userId = await makeUser();
    const planId = await seedPlan(userId, "broker");
    const jobId = await seedJob(planId);

    await seedExecution(jobId, {
      status: "finished",
      receiptText: EXECUTED,
      createdAt: at(0),
      uaTxId: "abcdef1234567890",
      feesJson: FEES,
      quoteJson: { uaDetail: { depositTokens: [{ chainId: 8453 }, { chainId: 42161 }] } },
    });
    await seedEvent(
      userId,
      "plan.activated",
      {
        planId,
        kind: "broker",
        contractPlanId: 7,
        receipt: brokerHiredReceipt({ amountUsd: 25, cadence: "weekly", tickers: ["SPYx", "SOL"] }),
      },
      at(1),
    );
    await seedEvent(
      userId,
      "sweep.receipt",
      {
        executionId: randomUUID(),
        headline: sweepReceiptHeadline(23.11, 5),
        fees: { gas: 0.01, service: 0.02, lp: 0, total: 0.03 },
        legs: [
          {
            chainId: 8453,
            network: "Base",
            token: "0xabc",
            symbol: "DEGEN",
            usd: 0.61,
            transactionId: "feedbeef12345678",
            outcome: "finished",
            serverVerified: true,
            fees: { gas: 0.01, service: 0.02, lp: 0, total: 0.03 },
            feeSource: "settled",
          },
        ],
      },
      at(2),
    );

    const { items } = await walk(userId, "all");
    expect(items).toHaveLength(3);
    // order: newest first
    expect(items.map((i) => i.variant)).toEqual(["executed", "system", "system"]);
    // sentences are the stored strings, byte-for-byte (CONFLICTS #18)
    expect(items[0].sentence).toBe(EXECUTED);
    expect(items[1].sentence).toBe(
      "Your Broker is hired — $25.00 every week across SPYx and SOL.",
    );
    expect(items[2].sentence).toBe("+$23.11 rescued from 5 networks.");
    // agents: plan kind for executions and plan events; null for sweeps
    expect(items.map((i) => i.agent)).toEqual(["broker", "broker", null]);
  });

  it("assembles detail: fees passthrough, derived sources, guarded link, planId, sweep legs", async () => {
    const userId = await makeUser();
    const planId = await seedPlan(userId);
    const jobId = await seedJob(planId);
    await seedExecution(jobId, {
      status: "finished",
      receiptText: EXECUTED,
      createdAt: at(0),
      uaTxId: "abcdef1234567890",
      feesJson: FEES,
      quoteJson: {
        uaDetail: { depositTokens: [{ token: { chainId: 8453 } }, { chainId: 42161 }] },
      },
    });

    const { items } = await walk(userId, "all");
    const detail = items[0].detail;
    expect(detail?.fees).toEqual(FEES); // exactly fees_json — never recomputed
    expect(detail?.sources).toEqual(["Base", "Arbitrum"]);
    expect(detail?.uaTxId).toBe("abcdef1234567890");
    expect(detail?.planId).toBe(planId);

    // sweep legs come through the shared mapper (guarded ids, no stored URLs)
    await seedEvent(
      userId,
      "sweep.receipt",
      {
        headline: sweepReceiptHeadline(1.5, 2),
        fees: { gas: 0, service: 0.01, lp: 0, total: 0.01 },
        legs: [
          {
            network: "BSC",
            outcome: "refunded",
            transactionId: "bad id with spaces",
            activityUrl: "https://evil.example/x",
          },
        ],
      },
      at(1),
    );
    const sweep = (await walk(userId, "system")).items[0];
    expect(sweep.detail?.legs).toHaveLength(1);
    expect(sweep.detail?.legs?.[0].uaTxId).toBeUndefined(); // failed the guard
    expect(JSON.stringify(sweep.detail)).not.toContain("evil.example");
  });

  it("renders kill rows (module 13): terminal legs + the aggregate; in-flight legs skipped", async () => {
    const userId = await makeUser();

    // In-flight leg: no receipt string yet → never a feed row (doc 13's
    // "legs stay out of the feed until terminal" contract).
    await seedEvent(
      userId,
      "kill.leg",
      { killId: randomUUID(), legId: randomUUID(), outcome: "submitted", assetId: "spyx" },
      at(0),
    );

    // Terminal leg: display-ready receipt + guarded link + fees.
    await seedEvent(
      userId,
      "kill.leg",
      {
        killId: randomUUID(),
        legId: randomUUID(),
        outcome: "settled",
        assetId: "spyx",
        qty: 0.05,
        usd: 32.11,
        receipt: killLegSoldReceipt("SPYx"),
        transactionId: "killtx1234567890",
        fees: FEES,
      },
      at(1),
    );

    // The aggregate: legs[] flow through the shared sweep mapper.
    await seedEvent(
      userId,
      "kill.receipt",
      {
        killId: randomUUID(),
        receipt: killReceiptText({ liquidated: 4, total: 5, retryable: 1, revoked: true }),
        fees: FEES,
        legs: [
          {
            chainId: 101,
            network: "Solana",
            symbol: "SPYx",
            usd: 32.11,
            outcome: "settled",
            serverVerified: true,
            transactionId: "killtx1234567890",
          },
          {
            chainId: 42161,
            network: "Arbitrum",
            symbol: "ETH",
            usd: 8.2,
            outcome: "failed",
            serverVerified: false,
            error: "quote expired",
            activityUrl: "https://evil.example/x",
          },
        ],
      },
      at(2),
    );

    const { items } = await walk(userId, "system");
    expect(items).toHaveLength(2); // in-flight leg skipped

    const [leg, aggregate] = items;
    expect(leg.sentence).toBe("Sold SPYx — now USDC in your balance.");
    expect(leg.variant).toBe("system");
    expect(leg.detail?.uaTxId).toBe("killtx1234567890");
    expect(leg.detail?.fees).toEqual(FEES);

    expect(aggregate.sentence).toBe(
      "Liquidated 4 of 5 positions to USDC · all agents revoked · 1 leg needs retry",
    );
    expect(aggregate.detail?.legs).toHaveLength(2);
    expect(aggregate.detail?.legs?.[0].outcome).toBe("settled");
    expect(aggregate.detail?.legs?.[0].uaTxId).toBe("killtx1234567890");
    expect(aggregate.detail?.legs?.[1].outcome).toBe("failed");
    expect(aggregate.detail?.legs?.[1].error).toBe("quote expired");
    // Stored URLs are ignored — links rebuild from guarded ids only.
    expect(JSON.stringify(aggregate.detail)).not.toContain("evil.example");
  });

  it("maps filters: trades / blocked / system partition the union", async () => {
    const userId = await makeUser();
    const planId = await seedPlan(userId);
    const jobId = await seedJob(planId);
    await seedExecution(jobId, { status: "finished", receiptText: EXECUTED, createdAt: at(0) });
    await seedExecution(jobId, { status: "refunded", receiptText: REFUNDED, createdAt: at(1) });
    await seedExecution(jobId, { status: "failed", receiptText: REFUNDED, createdAt: at(2) });
    await seedExecution(jobId, { status: "blocked", receiptText: BLOCKED, createdAt: at(3) });
    await seedEvent(userId, "plan.paused", { planId, receipt: "Your Broker is paused — nothing runs until you resume it." }, at(4));

    expect((await walk(userId, "trades")).items.map((i) => i.variant)).toEqual([
      "executed",
      "failed-refunded",
      "failed-refunded",
    ]);
    const blocked = (await walk(userId, "blocked")).items;
    expect(blocked.map((i) => i.variant)).toEqual(["blocked"]);
    expect(blocked[0].sentence).toBe("Blocked: exceeds your $50 weekly cap"); // CONFLICTS #10
    expect((await walk(userId, "system")).items.map((i) => i.variant)).toEqual(["system"]);
    expect((await walk(userId, "all")).items).toHaveLength(5);
  });

  it("excludes in-flight rows, empty receipts, and audit event types", async () => {
    const userId = await makeUser();
    const planId = await seedPlan(userId);
    const jobId = await seedJob(planId);
    // in-flight / mid-ladder rows (receipt_text = "")
    await seedExecution(jobId, { status: "quoted", receiptText: "", createdAt: at(0) });
    await seedExecution(jobId, { status: "recorded", receiptText: "", createdAt: at(1) });
    await seedExecution(jobId, { status: "submitted", receiptText: "", createdAt: at(2) });
    await seedExecution(jobId, { status: "failed", receiptText: "", createdAt: at(3) });
    // audit events that must NEVER render as receipts
    await seedEvent(userId, "execution.blocked", { planId, reason: "OverPeriodCap" }, at(4));
    await seedEvent(userId, "execution.skipped", { planId, cause: "insufficient-buying-power" }, at(5));
    await seedEvent(userId, "sweep.authorized", { executionId: randomUUID() }, at(6));
    await seedEvent(userId, "sweep.dismissed", {}, at(7));
    await seedEvent(userId, "sig.nonce", { nonce: 1 }, at(8));
    await seedEvent(userId, "intent.parsed", { draftId: randomUUID() }, at(9));
    await seedEvent(userId, "plan.autonomy_set", { planId, autonomy: "auto" }, at(10));
    // a malformed allowlisted event (no receipt string) is skipped, not invented
    await seedEvent(userId, "plan.activated", { planId, kind: "broker" }, at(11));

    expect((await walk(userId, "all")).items).toEqual([]);
  });

  it("scopes strictly to the session user", async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const planId = await seedPlan(alice);
    const jobId = await seedJob(planId);
    await seedExecution(jobId, { status: "finished", receiptText: EXECUTED, createdAt: at(0) });
    await seedEvent(alice, "plan.activated", { planId, kind: "broker", receipt: "Your Broker is hired — x." }, at(1));

    expect((await walk(bob, "all")).items).toEqual([]);
    expect((await walk(alice, "all")).items).toHaveLength(2);
  });

  it("degrades detail honestly: null fees_json → fees absent, never zeroed", async () => {
    const userId = await makeUser();
    const planId = await seedPlan(userId);
    const jobId = await seedJob(planId);
    await seedExecution(jobId, {
      status: "finished",
      receiptText: EXECUTED,
      createdAt: at(0),
      feesJson: null,
      uaTxId: "javascript:alert(1)", // fails the guard → no link field
    });

    const { items } = await walk(userId, "all");
    expect(items[0].detail?.fees).toBeUndefined();
    expect(items[0].detail?.uaTxId).toBeUndefined();
    expect(items[0].detail?.planId).toBe(planId); // the policy link still works
  });

  it("paginates at 30/page with a stable cursor (no dups, no gaps)", async () => {
    const userId = await makeUser();
    const planId = await seedPlan(userId);
    const jobId = await seedJob(planId);
    for (let i = 0; i < 33; i++) {
      await seedExecution(jobId, {
        status: "finished",
        receiptText: EXECUTED,
        createdAt: at(i),
      });
    }
    for (let i = 0; i < 5; i++) {
      await seedEvent(
        userId,
        "plan.resumed",
        { planId, receipt: "Your Broker is back on duty." },
        at(40 + i),
      );
    }

    const first = await caller(userId).activity.feed({ filter: "all" });
    expect(first.items).toHaveLength(30);
    expect(first.nextCursor).toBeDefined();

    const { items, pages } = await walk(userId, "all");
    expect(pages).toBe(2);
    expect(items).toHaveLength(38);
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(38); // no dups
    const times = items.map((i) => Date.parse(i.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times); // desc
  });

  it("never skips rows that differ only at microsecond precision (cursor boundary)", async () => {
    const userId = await makeUser();
    const planId = await seedPlan(userId);
    const jobId = await seedJob(planId);
    // 29 newer fillers…
    for (let i = 0; i < 29; i++) {
      await seedExecution(jobId, { status: "finished", receiptText: EXECUTED, createdAt: at(i) });
    }
    // …then two rows sharing the same millisecond, differing only in µs —
    // a naive full-precision cursor would skip whichever crosses the page
    // boundary second (its real µs value exceeds the ms-truncated cursor).
    const pairA = await seedExecution(jobId, { status: "finished", receiptText: EXECUTED, createdAt: at(50) });
    const pairB = await seedExecution(jobId, { status: "finished", receiptText: EXECUTED, createdAt: at(50) });
    await db.execute(
      sql`update executions set created_at = '2026-07-15T09:00:00.500901Z'::timestamptz where id = ${pairA}::uuid`,
    );
    await db.execute(
      sql`update executions set created_at = '2026-07-15T09:00:00.500104Z'::timestamptz where id = ${pairB}::uuid`,
    );

    const { items } = await walk(userId, "all"); // 31 rows → 2 pages
    expect(items).toHaveLength(31);
    const ids = new Set(items.map((i) => i.id));
    expect(ids.has(`ex_${pairA}`)).toBe(true);
    expect(ids.has(`ex_${pairB}`)).toBe(true);
  });

  it("honors the additive limit param (doc 12 mini-feed): newest N + cursor", async () => {
    const userId = await makeUser();
    const planId = await seedPlan(userId);
    const jobId = await seedJob(planId);
    for (let i = 0; i < 5; i++) {
      await seedExecution(jobId, {
        status: "finished",
        receiptText: EXECUTED,
        createdAt: at(i),
      });
    }

    const page = await caller(userId).activity.feed({ filter: "all", limit: 3 });
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeDefined(); // more exist beyond the mini-feed
    const times = page.items.map((i) => Date.parse(i.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times); // newest first
  });

  it("rejects a garbage cursor as BAD_REQUEST, never a 500", async () => {
    const userId = await makeUser();
    for (const bad of ["not-base64!!", "aGVsbG8", Buffer.from("{}").toString("base64url")]) {
      const err = await caller(userId)
        .activity.feed({ cursor: bad, filter: "all" })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("BAD_REQUEST");
    }
  });

  it("is gated: a pre-gate session is FORBIDDEN", async () => {
    const userId = await makeUser("");
    await db.execute(sql`update users set region = '' where id = ${userId}::uuid`);
    const err = await caller(userId)
      .activity.feed({ filter: "all" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
  });
});
