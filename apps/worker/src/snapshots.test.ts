import { executions, getDb, jobs, plans, portfolioSnapshots, users } from "@retenix/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotTick, type SnapshotDeps } from "./snapshots";

/*
 * Hourly snapshot cron over a real Postgres with network edges faked. Seeds
 * the same rows the executor writes (plans → jobs → finished executions with
 * quote_json.fill) and asserts the written valuation rows.
 */

const db = getDb();
const PREFIX = "0xsnapshot-test";
const SPYX_MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const NOW = new Date("2026-07-16T12:00:00.000Z");

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;

const spyxAccounts = {
  value: [
    {
      account: {
        data: {
          parsed: {
            info: {
              mint: SPYX_MINT,
              tokenAmount: { uiAmountString: "0.05" },
            },
          },
        },
      },
    },
  ],
};

function fakeDeps(over: Partial<SnapshotDeps> = {}): SnapshotDeps & {
  fetchSpy: ReturnType<typeof vi.fn>;
} {
  const fetchSpy = vi.fn(() =>
    Promise.resolve(
      okJson({
        [SPYX_MINT]: { usdPrice: 600 },
        [SOL_MINT]: { usdPrice: 150 },
      }),
    ),
  );
  return {
    rpc: (_url, _method, params) => {
      const [, program] = params as [string, { programId: string }];
      return Promise.resolve(
        program.programId.startsWith("Tokenkeg") ? spyxAccounts : { value: [] },
      );
    },
    fetchImpl: fetchSpy as unknown as typeof fetch,
    now: () => NOW,
    fetchSpy,
    ...over,
  };
}

async function seedUser(
  suffix: string,
  uaSolAddr = "7fUAJdStEuGbc3sM84cKRL6yYaaSstyLSU4ve5oovLS7",
): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      emailHash: `${PREFIX}-${suffix}`,
      eoaAddr: `0xE0A000000000000000000000000000000000${suffix.padStart(4, "0")}`,
      uaEvmAddr: "0x0",
      uaSolAddr,
      region: "DE",
    })
    .returning({ id: users.id });
  return row.id;
}

async function seedFinishedBuy(
  userId: string,
  fill: { assetId: string; usd: number; qty: number | null },
): Promise<void> {
  const [plan] = await db
    .insert(plans)
    .values({ userId, kind: "broker", paramsJson: {}, status: "active" })
    .returning({ id: plans.id });
  const [job] = await db
    .insert(jobs)
    .values({
      planId: plan.id,
      runAt: NOW,
      periodKey: `${plan.id}:2026-07-13T12:00:00.000Z:0`,
      status: "done",
    })
    .returning({ id: jobs.id });
  await db.insert(executions).values({
    jobId: job.id,
    quoteJson: { fill },
    status: "finished",
    receiptText: "Bought $15.00 of SPYX · view onchain",
  });
}

async function snapshotsOf(userId: string) {
  return db
    .select()
    .from(portfolioSnapshots)
    .where(sql`${portfolioSnapshots.userId} = ${userId}`);
}

async function cleanup(): Promise<void> {
  const like = `${PREFIX}%`;
  await db.execute(sql`
    delete from executions where job_id in (
      select j.id from jobs j join plans p on p.id = j.plan_id
      join users u on u.id = p.user_id where u.email_hash like ${like})`);
  await db.execute(sql`
    delete from jobs where plan_id in (
      select p.id from plans p join users u on u.id = p.user_id
      where u.email_hash like ${like})`);
  await db.execute(sql`
    delete from plans where user_id in (
      select id from users where email_hash like ${like})`);
  await db.execute(sql`
    delete from portfolio_snapshots where user_id in (
      select id from users where email_hash like ${like})`);
  await db.execute(sql`delete from users where email_hash like ${like}`);
}

beforeEach(cleanup);
afterAll(cleanup);

describe("snapshotTick", () => {
  it("values a user's positions and writes one snapshot row", async () => {
    const userId = await seedUser("a1");
    await seedFinishedBuy(userId, { assetId: "spyx", usd: 15, qty: 0.05 });

    const res = await snapshotTick({ db }, fakeDeps(), { userIds: [userId] });
    expect(res).toEqual({ scanned: 1, written: 1 });

    const [row] = await snapshotsOf(userId);
    expect(row.totalUsd).toBeCloseTo(30); // 0.05 × $600
    expect(row.at.toISOString()).toBe(NOW.toISOString());
    expect(row.perAssetJson).toEqual({
      spyx: { qty: 0.05, markUsd: 600, valueUsd: 30 },
    });
  });

  it("SOL rides the ledger; marks fetch happens ONCE across users", async () => {
    const emptySol = "EmptyownerZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    const a = await seedUser("b1");
    const b = await seedUser("b2", emptySol); // no chain equities for B
    await seedFinishedBuy(a, { assetId: "spyx", usd: 15, qty: 0.05 });
    await seedFinishedBuy(b, { assetId: "sol", usd: 15, qty: 0.1 });

    const deps = fakeDeps({
      rpc: (_url, _method, params) => {
        const [owner, program] = params as [string, { programId: string }];
        return Promise.resolve(
          owner !== emptySol && program.programId.startsWith("Tokenkeg")
            ? spyxAccounts
            : { value: [] },
        );
      },
    });
    const res = await snapshotTick({ db }, deps, { userIds: [a, b] });
    expect(res).toEqual({ scanned: 2, written: 2 });
    expect(deps.fetchSpy).toHaveBeenCalledTimes(1);

    const [rowB] = await snapshotsOf(b);
    expect(rowB.totalUsd).toBeCloseTo(15); // 0.1 × $150
    expect((rowB.perAssetJson as Record<string, unknown>).sol).toEqual({
      qty: 0.1,
      markUsd: 150,
      valueUsd: 15,
    });
  });

  it("a user whose sources fail is skipped without holing other users", async () => {
    const brokenSol = "BrokenownerZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    const a = await seedUser("c1", brokenSol);
    const b = await seedUser("c2");
    await seedFinishedBuy(a, { assetId: "spyx", usd: 15, qty: 0.05 });
    await seedFinishedBuy(b, { assetId: "sol", usd: 15, qty: 0.1 });

    const deps = fakeDeps({
      rpc: (_url, _method, params) => {
        const [owner] = params as [string];
        return owner === brokenSol
          ? Promise.reject(new Error("rpc down"))
          : Promise.resolve({ value: [] });
      },
    });

    const res = await snapshotTick({ db }, deps, { userIds: [a, b] });
    expect(res.scanned).toBe(2);
    expect(res.written).toBe(1); // user B, whatever the scan order
    expect(await snapshotsOf(a)).toHaveLength(0);
    expect((await snapshotsOf(b))[0].totalUsd).toBeCloseTo(15);
  });

  it("skips never-held users but keeps writing the honest zero after an exit", async () => {
    const userId = await seedUser("d1");
    await seedFinishedBuy(userId, { assetId: "spyx", usd: 15, qty: 0.05 });

    // Position gone from chain (sold externally / kill switch) but history
    // exists → the drop to zero is recorded.
    await db.insert(portfolioSnapshots).values({
      userId,
      totalUsd: 30,
      perAssetJson: { spyx: { qty: 0.05, markUsd: 600, valueUsd: 30 } },
      at: new Date("2026-07-16T11:00:00.000Z"),
    });
    const deps = fakeDeps({ rpc: () => Promise.resolve({ value: [] }) });
    const res = await snapshotTick({ db }, deps, { userIds: [userId] });
    expect(res.written).toBe(1);
    const rows = await snapshotsOf(userId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.totalUsd).sort((x, y) => x - y)[0]).toBe(0);

    // A user with a finished execution but nothing held and no history: no row.
    await cleanup();
    const fresh = await seedUser("d2");
    await seedFinishedBuy(fresh, { assetId: "spyx", usd: 15, qty: null });
    const res2 = await snapshotTick(
      { db },
      fakeDeps({ rpc: () => Promise.resolve({ value: [] }) }),
      { userIds: [fresh] },
    );
    expect(res2).toEqual({ scanned: 1, written: 0 });
    expect(await snapshotsOf(fresh)).toHaveLength(0);
  });
});
