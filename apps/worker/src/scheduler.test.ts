import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { events, executions, getDb, getPool, jobs, plans, users, type Db } from "@retenix/db";
import { advanceSchedule } from "@retenix/shared";

import type { BossLike } from "./ctx";
import {
  __resetSchedulerLogDedupe,
  buildPeriodKey,
  enqueuePlanNow,
  enqueueRogue,
  isRoguePeriodKey,
  rescueOrphans,
  scanDuePlans,
} from "./scheduler";

// Same discipline as packages/db/test/period-key.test.ts: soft-skip without
// a live Postgres locally, hard-fail in CI.
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL must be set in CI — db tests may not be skipped");
}
if (!url) {
  console.warn("[worker] DATABASE_URL not set — skipping scheduler db tests");
}

interface SentJob {
  data: { jobId: string };
  opts: { singletonKey: string; startAfter?: number };
}

function fakeBoss(): { boss: BossLike; sends: SentJob[] } {
  const sends: SentJob[] = [];
  const boss: BossLike = {
    send: (_name, data, opts) => {
      sends.push({ data: data as { jobId: string }, opts });
      return Promise.resolve("queued");
    },
  };
  return { boss, sends };
}

describe.skipIf(!url)("scheduler (db-backed)", () => {
  let db: Db;
  const userId = randomUUID();
  const weeklyPlanId = randomUUID();
  const dailyPlanId = randomUUID();
  const roguePlanId = randomUUID();
  const allPlanIds = [weeklyPlanId, dailyPlanId, roguePlanId];

  // Fixed clock: activation 3 days before "now", weekly cadence → the
  // current cap window starts AT activation.
  const activatedAt = new Date("2026-07-13T09:00:00.000Z");
  const now = new Date("2026-07-16T09:00:00.000Z");
  const storedNextRunAt = "2026-07-16T08:59:00.000Z"; // due 1 min ago

  const weeklyParams = {
    cadence: "weekly" as const,
    amountUsd: 25,
    basket: [
      { assetId: "spyx", pct: 60 },
      { assetId: "tslax", pct: 30 },
      { assetId: "sol", pct: 10 },
    ],
    capPerExecUsd: 50,
    capPerPeriodUsd: 50,
    periodSecs: 604_800,
    nextRunAt: storedNextRunAt,
    topUpOptIn: false,
  };

  beforeAll(async () => {
    db = getDb();
    await db.insert(users).values({
      id: userId,
      emailHash: `sched-${userId}`,
      eoaAddr: `0xsched${userId}`,
      uaEvmAddr: "0x0000000000000000000000000000000000000000",
      uaSolAddr: "So11111111111111111111111111111111111111112",
      region: "NG",
    });
    await db.insert(plans).values([
      {
        id: weeklyPlanId,
        userId,
        kind: "broker",
        paramsJson: weeklyParams,
        contractPlanId: 1,
        status: "active",
        activatedAt,
      },
      {
        id: dailyPlanId,
        userId,
        kind: "broker",
        paramsJson: {
          ...weeklyParams,
          cadence: "daily" as const,
          amountUsd: 2,
          basket: [{ assetId: "sol", pct: 100 }],
          periodSecs: 86_400,
          nextRunAt: "2026-07-17T09:00:00.000Z", // NOT due — execute-now path
        },
        contractPlanId: 2,
        status: "active",
        activatedAt,
      },
      {
        id: roguePlanId,
        userId,
        kind: "broker",
        paramsJson: weeklyParams,
        contractPlanId: 3,
        status: "active",
        activatedAt,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(executions).where(
      inArray(
        executions.jobId,
        db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.planId, allPlanIds)),
      ),
    );
    await db.delete(jobs).where(inArray(jobs.planId, allPlanIds));
    await db
      .delete(events)
      .where(
        sql`${events.payloadJson}->>'planId' IN (${sql.join(
          allPlanIds.map((id) => sql`${id}`),
          sql`, `,
        )}) OR ${events.userId} = ${userId} OR ${events.payloadJson}->>'jobId' IN (SELECT id::text FROM jobs WHERE plan_id IN (${sql.join(
          allPlanIds.map((id) => sql`${id}`),
          sql`, `,
        )}))`,
      );
    await db.delete(plans).where(inArray(plans.id, allPlanIds));
    await db.delete(users).where(eq(users.id, userId));
    await getPool().end();
  });

  beforeEach(() => {
    __resetSchedulerLogDedupe();
  });

  const periodStartIso = activatedAt.toISOString(); // 3d into a 7d window

  it("scan splits the due $25 weekly plan into three idempotent leg jobs", async () => {
    const { boss, sends } = fakeBoss();
    await scanDuePlans({ db, boss }, now);

    const rows = await db
      .select()
      .from(jobs)
      .where(eq(jobs.planId, weeklyPlanId))
      .orderBy(jobs.periodKey);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.periodKey)).toEqual([
      buildPeriodKey(weeklyPlanId, periodStartIso, 0),
      buildPeriodKey(weeklyPlanId, periodStartIso, 1),
      buildPeriodKey(weeklyPlanId, periodStartIso, 2),
    ]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);

    // One singleton send per leg, keyed on period_key.
    const weeklySends = sends.filter((s) => s.opts.singletonKey.startsWith(weeklyPlanId));
    expect(weeklySends.map((s) => s.opts.singletonKey).sort()).toEqual(
      rows.map((r) => r.periodKey).sort(),
    );

    // nextRunAt advanced on the activation-anchored weekly grid.
    const [plan] = await db
      .select({ paramsJson: plans.paramsJson })
      .from(plans)
      .where(eq(plans.id, weeklyPlanId));
    const expected = advanceSchedule("weekly", activatedAt, new Date(storedNextRunAt), now);
    expect((plan.paramsJson as { nextRunAt: string }).nextRunAt).toBe(
      expected.next.toISOString(),
    );
  });

  it("a re-scan at the same instant is a no-op (plan no longer due)", async () => {
    const { boss, sends } = fakeBoss();
    await scanDuePlans({ db, boss }, now);
    const rows = await db.select().from(jobs).where(eq(jobs.planId, weeklyPlanId));
    expect(rows).toHaveLength(3);
    expect(sends.filter((s) => s.opts.singletonKey.startsWith(weeklyPlanId))).toHaveLength(0);
  });

  it("crash before the nextRunAt advance replays safely (ON CONFLICT + null-safe resend)", async () => {
    // Simulate S11/S12: jobs already exist but nextRunAt never advanced.
    await db
      .update(plans)
      .set({
        paramsJson: sql`jsonb_set(${plans.paramsJson}, '{nextRunAt}', to_jsonb(${storedNextRunAt}::text))`,
      })
      .where(eq(plans.id, weeklyPlanId));

    const { boss, sends } = fakeBoss();
    await scanDuePlans({ db, boss }, now);

    const rows = await db.select().from(jobs).where(eq(jobs.planId, weeklyPlanId));
    expect(rows).toHaveLength(3); // no duplicates — the unique index held
    // Re-sends fire (twins would resolve null in real pg-boss — harmless).
    expect(sends.filter((s) => s.opts.singletonKey.startsWith(weeklyPlanId))).toHaveLength(3);
    const [plan] = await db
      .select({ paramsJson: plans.paramsJson })
      .from(plans)
      .where(eq(plans.id, weeklyPlanId));
    expect((plan.paramsJson as { nextRunAt: string }).nextRunAt).not.toBe(storedNextRunAt);
  });

  it("execute-now enqueues the current period once, idempotently", async () => {
    const { boss, sends } = fakeBoss();
    const first = await enqueuePlanNow({ db, boss }, dailyPlanId, now);
    const second = await enqueuePlanNow({ db, boss }, dailyPlanId, now);
    expect("jobIds" in first && first.jobIds).toHaveLength(1);
    expect("jobIds" in second && second.jobIds).toEqual(
      "jobIds" in first ? first.jobIds : [],
    );
    const rows = await db.select().from(jobs).where(eq(jobs.planId, dailyPlanId));
    expect(rows).toHaveLength(1); // ON CONFLICT swallowed the second insert
    expect(sends).toHaveLength(2); // re-send is fine — singleton twins no-op
  });

  it("execute-now rejects unknown or inactive plans", async () => {
    const { boss } = fakeBoss();
    expect(await enqueuePlanNow({ db, boss }, randomUUID(), now)).toHaveProperty("error");
  });

  it("rogue enqueue writes a crash-durable :rogue: period key", async () => {
    const { boss, sends } = fakeBoss();
    const out = await enqueueRogue({ db, boss }, roguePlanId);
    expect("jobId" in out).toBe(true);
    if ("jobId" in out) {
      expect(isRoguePeriodKey(out.periodKey)).toBe(true);
      expect(out.periodKey.startsWith(`${roguePlanId}:rogue:`)).toBe(true);
      expect(sends[0].opts.singletonKey).toBe(out.periodKey);
    }
  });

  it("janitor rescues quiet stuck jobs, skips fresh/active ones, and bounds resurrections", async () => {
    const staleRunAt = new Date(now.getTime() - 20 * 60 * 1000);

    // (a) quiet + stale → rescued
    const [stuck] = await db
      .insert(jobs)
      .values({
        planId: roguePlanId,
        runAt: staleRunAt,
        periodKey: `${roguePlanId}:janitor:${randomUUID()}`,
        status: "pending",
      })
      .returning({ id: jobs.id, periodKey: jobs.periodKey });

    // (b) stale but with a RECENT execution row (mid-backoff) → left alone
    const [active] = await db
      .insert(jobs)
      .values({
        planId: roguePlanId,
        runAt: staleRunAt,
        periodKey: `${roguePlanId}:janitor:${randomUUID()}`,
        status: "running",
      })
      .returning({ id: jobs.id });
    await db.insert(executions).values({
      jobId: active.id,
      status: "refunded",
      receiptText: "",
      createdAt: new Date(now.getTime() - 60 * 1000),
    });

    // (c) fresh → left alone
    const [fresh] = await db
      .insert(jobs)
      .values({
        planId: roguePlanId,
        runAt: now,
        periodKey: `${roguePlanId}:janitor:${randomUUID()}`,
        status: "pending",
      })
      .returning({ id: jobs.id });

    const { boss, sends } = fakeBoss();
    await rescueOrphans({ db, boss }, now);

    const rescuedIds = sends.map((s) => s.data.jobId);
    expect(rescuedIds).toContain(stuck.id);
    expect(rescuedIds).not.toContain(active.id);
    expect(rescuedIds).not.toContain(fresh.id);

    // Resurrection bound: after MAX (5) recorded rescues, the job is failed.
    for (let i = 0; i < 5; i += 1) {
      await db.insert(events).values({
        userId: null,
        type: "job.resurrected",
        payloadJson: { jobId: stuck.id, periodKey: stuck.periodKey },
      });
    }
    const { boss: boss2, sends: sends2 } = fakeBoss();
    await rescueOrphans({ db, boss: boss2 }, now);
    expect(sends2.map((s) => s.data.jobId)).not.toContain(stuck.id);
    const [after] = await db
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, stuck.id));
    expect(after.status).toBe("failed");
    const exhausted = await db
      .select()
      .from(events)
      .where(
        and(eq(events.type, "job.rescue_exhausted"), sql`${events.payloadJson}->>'jobId' = ${stuck.id}`),
      );
    expect(exhausted).toHaveLength(1);
  });
});
