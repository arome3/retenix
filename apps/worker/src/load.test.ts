import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, getDb, getPool, jobs, plans, users, type Db } from "@retenix/db";

import type { BossLike } from "./ctx";
import { scanDuePlans } from "./scheduler";
import { UA_CONCURRENCY, uaQueue } from "./ua-exec";

const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL must be set in CI — db tests may not be skipped");
}

describe.skipIf(!url)("load sanity — 100 due legs enqueue in one scan (doc 08)", () => {
  let db: Db;
  const userId = randomUUID();
  const planIds = Array.from({ length: 20 }, () => randomUUID());

  beforeAll(async () => {
    db = getDb();
    await db.insert(users).values({
      id: userId,
      emailHash: `load-${userId}`,
      eoaAddr: `0xload${userId}`,
      uaEvmAddr: "0x0000000000000000000000000000000000000000",
      uaSolAddr: "So11111111111111111111111111111111111111112",
      region: "NG",
    });
    // 20 plans × 5 legs (the contract's allowlist maximum) = 100 due legs.
    await db.insert(plans).values(
      planIds.map((id, i) => ({
        id,
        userId,
        kind: "broker" as const,
        status: "active" as const,
        contractPlanId: 1_000 + i,
        activatedAt: new Date("2026-07-13T09:00:00.000Z"),
        paramsJson: {
          cadence: "weekly",
          amountUsd: 25,
          basket: [
            { assetId: "spyx", pct: 20 },
            { assetId: "tslax", pct: 20 },
            { assetId: "qqqx", pct: 20 },
            { assetId: "nvdax", pct: 20 },
            { assetId: "sol", pct: 20 },
          ],
          capPerExecUsd: 50,
          capPerPeriodUsd: 50,
          periodSecs: 604_800,
          nextRunAt: "2026-07-16T08:59:00.000Z",
        },
      })),
    );
  });

  afterAll(async () => {
    await db.delete(jobs).where(inArray(jobs.planId, planIds));
    await db.delete(events).where(eq(events.userId, userId));
    await db.delete(plans).where(inArray(plans.id, planIds));
    await db.delete(users).where(eq(users.id, userId));
    await getPool().end();
  });

  it("one scan inserts all 100 leg jobs with unique period keys and sends each once", async () => {
    const sends: string[] = [];
    const boss: BossLike = {
      send: (_n, _d, opts) => {
        sends.push(opts.singletonKey);
        return Promise.resolve("q");
      },
    };
    const started = Date.now();
    await scanDuePlans({ db, boss }, new Date("2026-07-16T09:00:00.000Z"));
    const elapsed = Date.now() - started;

    const rows = await db
      .select({ periodKey: jobs.periodKey })
      .from(jobs)
      .where(inArray(jobs.planId, planIds));
    expect(rows).toHaveLength(100);
    expect(new Set(rows.map((r) => r.periodKey)).size).toBe(100);
    expect(sends).toHaveLength(100);
    expect(new Set(sends).size).toBe(100);
    // Sanity, not a benchmark: a minute-cadence scan must finish well inside
    // its minute even on a laptop Postgres.
    expect(elapsed).toBeLessThan(30_000);

    // Idempotency at scale: an immediate second scan neither duplicates rows
    // nor re-advances (the plans are no longer due).
    const sendsBefore = sends.length;
    await scanDuePlans({ db, boss }, new Date("2026-07-16T09:00:00.000Z"));
    const again = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(inArray(jobs.planId, planIds));
    expect(again).toHaveLength(100);
    expect(sends.length).toBe(sendsBefore);
  });
});

describe("OQ2 fallback — UA concurrency capped at 2", () => {
  it("the shared uaQueue never runs more than 2 tasks at once", async () => {
    expect(UA_CONCURRENCY).toBe(2);
    expect(uaQueue.concurrency).toBe(2);

    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 25 }, () =>
      uaQueue.add(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
      }),
    );
    await Promise.all(tasks);
    expect(peak).toBe(2);
    expect(inFlight).toBe(0);
  });
});
