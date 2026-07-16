import { events, executions, getDb, jobs, plans, portfolioSnapshots, users } from "@retenix/db";
import { SOL_NATIVE_MINT } from "@retenix/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import type { HoldingsDeps } from "../lib/holdings";

/*
 * portfolio.holdings over a real Postgres with the network edges faked
 * (Solana RPC + Jupiter fetch via the injected HoldingsDeps — the sweep-route
 * test's seam pattern). Seeds the same rows the worker writes: plans → jobs
 * (numeric-seq period keys) → finished executions carrying quote_json.fill.
 */

vi.mock("../lib/holdings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/holdings")>();
  return { ...actual, defaultHoldingsDeps: vi.fn() };
});

const holdingsLib = await import("../lib/holdings");
const depsMock = vi.mocked(holdingsLib.defaultHoldingsDeps);
const { holdingsCache } = holdingsLib;
const { appRouter } = await import("./index");

const db = getDb();
const EMAIL_HASH = "0xportfolio-route-test-emailhash";
const SPYX_MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const UA_SOL = "7fUAJdStEuGbc3sM84cKRL6yYaaSstyLSU4ve5oovLS7";
const NOW = new Date("2026-07-16T12:00:00.000Z");

let userId: string;

const ctx = (region = "DE"): Context => ({
  db,
  session: { userId, eoaAddr: "0xE0A0000000000000000000000000000000000012", issuer: "did:test", region },
  headers: new Headers(),
  resHeaders: new Headers(),
});

const caller = () => appRouter.createCaller(ctx());

// --- deps fakes ---------------------------------------------------------------

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;

/** One SPYx token account on the first program, nothing on the second. */
const rpcWithSpyx =
  (uiAmountString: string) =>
  (_url: string, method: string, params: unknown[]): Promise<unknown> => {
    expect(method).toBe("getTokenAccountsByOwner");
    const [owner, program] = params as [string, { programId: string }];
    expect(owner).toBe(UA_SOL);
    if (program.programId.startsWith("Tokenkeg")) {
      return Promise.resolve({
        value: [
          {
            account: {
              data: {
                parsed: {
                  info: {
                    mint: SPYX_MINT,
                    tokenAmount: { uiAmountString, decimals: 8 },
                  },
                },
              },
            },
          },
        ],
      });
    }
    return Promise.resolve({ value: [] });
  };

const jupiterOk = vi.fn(() =>
  Promise.resolve(
    okJson({
      [SPYX_MINT]: { usdPrice: 600 },
      [SOL_NATIVE_MINT]: { usdPrice: 150 },
    }),
  ),
);

function fakeDeps(over: Partial<HoldingsDeps> = {}): HoldingsDeps {
  return {
    rpc: rpcWithSpyx("0.05"),
    fetchImpl: jupiterOk as unknown as typeof fetch,
    now: () => NOW,
    ...over,
  };
}

// --- seeding -------------------------------------------------------------------

const PERIOD_ISO = "2026-07-13T12:00:00.000Z";

async function seedUser(region = "DE"): Promise<void> {
  const [row] = await db
    .insert(users)
    .values({
      emailHash: EMAIL_HASH,
      eoaAddr: "0xE0A0000000000000000000000000000000000012",
      uaEvmAddr: "0xE0A0000000000000000000000000000000000012",
      uaSolAddr: UA_SOL,
      region,
    })
    .returning({ id: users.id });
  userId = row.id;
}

async function seedBuy(opts: {
  assetId: string;
  usd: number;
  qty: number | null;
  seq?: number;
  status?: "finished" | "refunded";
  fill?: boolean; // false → the pre-fill fallback path (periodKey + params)
  quoteJson?: unknown; // overrides entirely when provided
  at?: string;
}): Promise<void> {
  const [plan] = await db
    .insert(plans)
    .values({
      userId,
      kind: "broker",
      paramsJson: {
        cadence: "weekly",
        amountUsd: opts.usd,
        basket: [{ assetId: opts.assetId, pct: 100 }],
        capPerExecUsd: opts.usd,
        capPerPeriodUsd: opts.usd * 2,
        periodSecs: 604_800,
        nextRunAt: "2026-07-20T12:00:00.000Z",
        autonomy: "auto",
        topUpOptIn: false,
      },
      status: "active",
      activatedAt: new Date(PERIOD_ISO),
    })
    .returning({ id: plans.id });

  const [job] = await db
    .insert(jobs)
    .values({
      planId: plan.id,
      runAt: new Date(PERIOD_ISO),
      periodKey: `${plan.id}:${PERIOD_ISO}:${opts.seq ?? 0}`,
      status: "done",
    })
    .returning({ id: jobs.id });

  const quoteJson =
    opts.quoteJson !== undefined
      ? opts.quoteJson
      : opts.fill === false
        ? {
            uaDetail: {
              tokenChanges:
                opts.qty === null
                  ? {}
                  : {
                      incr: [
                        {
                          token: {
                            address: opts.assetId === "sol" ? SOL_NATIVE_MINT : SPYX_MINT,
                          },
                          amount: String(opts.qty),
                        },
                      ],
                    },
            },
          }
        : { fill: { assetId: opts.assetId, usd: opts.usd, qty: opts.qty } };

  await db.insert(executions).values({
    jobId: job.id,
    uaTxId: `UA-${Math.random().toString(36).slice(2, 10)}`,
    quoteJson,
    feesJson: { gas: 0.03, service: 0.08, lp: 0.03, total: 0.14 },
    status: opts.status ?? "finished",
    receiptText: `Bought $${opts.usd.toFixed(2)} of ${opts.assetId.toUpperCase()} · view onchain`,
    createdAt: opts.at ? new Date(opts.at) : new Date(PERIOD_ISO),
  });
}

async function cleanup(): Promise<void> {
  const prefix = "0xportfolio-route-test%";
  await db.execute(sql`
    delete from executions where job_id in (
      select j.id from jobs j join plans p on p.id = j.plan_id
      join users u on u.id = p.user_id where u.email_hash like ${prefix})`);
  await db.execute(sql`
    delete from jobs where plan_id in (
      select p.id from plans p join users u on u.id = p.user_id
      where u.email_hash like ${prefix})`);
  await db.execute(sql`
    delete from plans where user_id in (
      select id from users where email_hash like ${prefix})`);
  await db.execute(sql`
    delete from events where user_id in (
      select id from users where email_hash like ${prefix})`);
  await db.execute(sql`
    delete from portfolio_snapshots where user_id in (
      select id from users where email_hash like ${prefix})`);
  await db.execute(sql`delete from users where email_hash like ${prefix}`);
}

beforeEach(async () => {
  vi.clearAllMocks();
  holdingsCache.clear();
  depsMock.mockReturnValue(fakeDeps());
  await cleanup();
  await seedUser();
});

afterAll(async () => {
  await cleanup();
});

// --- specs ---------------------------------------------------------------------

describe("portfolio.holdings", () => {
  it("FORBIDDEN before the eligibility gate (asset route composes off gatedProcedure)", async () => {
    await db.update(users).set({ region: "" }).where(eq(users.id, userId));
    await expect(caller().portfolio.holdings()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("multi-buy average-cost basis reconciles with chain balance and live marks", async () => {
    // Two $15 buys filling 0.024 + 0.026 = 0.05 SPYx — exactly the chain balance.
    await seedBuy({ assetId: "spyx", usd: 15, qty: 0.024 });
    await seedBuy({ assetId: "spyx", usd: 15, qty: 0.026, at: "2026-07-14T12:00:00.000Z" });

    const res = await caller().portfolio.holdings();
    expect(res.holdings).toHaveLength(1);
    const spyx = res.holdings[0];
    expect(spyx.assetId).toBe("spyx");
    expect(spyx.qty).toBeCloseTo(0.05);
    expect(spyx.qtyHuman).toBe("0.05");
    expect(spyx.markUsd).toBe(600);
    expect(spyx.markStale).toBe(false);
    expect(spyx.valueUsd).toBeCloseTo(30);
    expect(spyx.costBasisUsd).toBeCloseTo(30);
    expect(spyx.deltaUsd).toBeCloseTo(0);
    expect(res.totalUsd).toBeCloseTo(30);
    expect(res.costBasisUsd).toBeCloseTo(30);
    expect(res.returnUsd).toBeCloseTo(0);
    expect(res.unattributedBuys).toBe(0);
    // Disclosure passthrough: SPYx (equity) carries its registry line.
    expect(spyx.disclosure).toContain("Issuer: Backed");
  });

  it("pre-fill rows attribute via periodKey seq + plan basket + uaDetail tokenChanges", async () => {
    await seedBuy({ assetId: "spyx", usd: 15, qty: 0.05, fill: false });

    const res = await caller().portfolio.holdings();
    const spyx = res.holdings[0];
    expect(spyx.costBasisUsd).toBeCloseTo(15);
    expect(spyx.deltaUsd).toBeCloseTo(30 - 15);
    expect(spyx.deltaPct).toBeCloseTo(100);
  });

  it("a sell.receipt event reduces basis proportionally (average-cost)", async () => {
    await seedBuy({ assetId: "spyx", usd: 30, qty: 0.1 });
    await db.insert(events).values({
      userId,
      type: "sell.receipt",
      payloadJson: {
        assetId: "spyx",
        qty: 0.05,
        usd: 31,
        outcome: "finished",
        receipt: "Sold SPYx — proceeds added to your buying power",
      },
      createdAt: new Date("2026-07-15T12:00:00.000Z"),
    });
    depsMock.mockReturnValue(fakeDeps({ rpc: rpcWithSpyx("0.05") }));

    const res = await caller().portfolio.holdings();
    const spyx = res.holdings[0];
    expect(spyx.qty).toBeCloseTo(0.05);
    expect(spyx.costBasisUsd).toBeCloseTo(15); // half the $30 basis remains
  });

  it("refunded executions never touch basis (only finished rows are fills)", async () => {
    await seedBuy({ assetId: "spyx", usd: 15, qty: 0.05 });
    await seedBuy({ assetId: "spyx", usd: 99, qty: 0.5, status: "refunded", seq: 1 });

    const res = await caller().portfolio.holdings();
    expect(res.holdings[0].costBasisUsd).toBeCloseTo(15);
  });

  it("SOL rides the execution ledger (no chain scan), no disclosure on crypto", async () => {
    await seedBuy({ assetId: "sol", usd: 15, qty: 0.1 });
    depsMock.mockReturnValue(
      fakeDeps({ rpc: () => Promise.resolve({ value: [] }) }),
    );

    const res = await caller().portfolio.holdings();
    expect(res.holdings).toHaveLength(1);
    const sol = res.holdings[0];
    expect(sol.assetId).toBe("sol");
    expect(sol.qty).toBeCloseTo(0.1);
    expect(sol.markUsd).toBe(150);
    expect(sol.disclosure).toBeUndefined();
  });

  it("unknown fill qty renders basis as null for that asset — never guessed", async () => {
    await seedBuy({ assetId: "spyx", usd: 15, qty: null });

    const res = await caller().portfolio.holdings();
    const spyx = res.holdings[0];
    expect(spyx.qty).toBeCloseTo(0.05); // chain still states the position
    expect(spyx.costBasisUsd).toBeNull();
    expect(spyx.deltaUsd).toBeNull();
    expect(spyx.deltaPct).toBeNull();
    expect(res.returnUsd).toBeNull();
  });

  it("an unattributable finished trade poisons EVERY basis (global suspicion)", async () => {
    await seedBuy({ assetId: "spyx", usd: 15, qty: 0.05 });
    // A finished execution whose job has an e2e-style uuid period key and no
    // usable quote_json — could have been any asset.
    const [plan] = await db
      .insert(plans)
      .values({ userId, kind: "broker", paramsJson: {}, status: "active" })
      .returning({ id: plans.id });
    const [job] = await db
      .insert(jobs)
      .values({
        planId: plan.id,
        runAt: new Date(PERIOD_ISO),
        periodKey: `${plan.id}:e2e:8b8f4c1e-1111-4222-8333-9d7e6b3c4a10`,
        status: "done",
      })
      .returning({ id: jobs.id });
    await db.insert(executions).values({
      jobId: job.id,
      quoteJson: {},
      status: "finished",
      receiptText: "Bought $15.00 of SPYx · view onchain",
    });

    const res = await caller().portfolio.holdings();
    expect(res.unattributedBuys).toBe(1);
    expect(res.holdings[0].costBasisUsd).toBeNull();
    expect(res.costBasisUsd).toBe(0);
    expect(res.returnUsd).toBeNull();
  });

  it("Jupiter omitting a mint falls back to last-trade with the stale marker", async () => {
    await seedBuy({ assetId: "spyx", usd: 15, qty: 0.05 });
    depsMock.mockReturnValue(
      fakeDeps({
        fetchImpl: vi.fn(() => Promise.resolve(okJson({}))) as unknown as typeof fetch,
      }),
    );

    const res = await caller().portfolio.holdings();
    const spyx = res.holdings[0];
    expect(spyx.markStale).toBe(true);
    expect(spyx.markUsd).toBeCloseTo(300); // $15 / 0.05 — the last trade
  });

  it("source failure serves the last-known statement with its OLD asOf; none → BAD_GATEWAY", async () => {
    await seedBuy({ assetId: "spyx", usd: 15, qty: 0.05 });
    const first = await caller().portfolio.holdings();
    expect(first.asOf).toBe(NOW.toISOString());

    depsMock.mockReturnValue(
      fakeDeps({
        rpc: () => Promise.reject(new Error("solana rpc down")),
        now: () => new Date("2026-07-16T13:00:00.000Z"),
      }),
    );
    // Cache is fresh for 30s from asOf — force staleness by aging the entry.
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-16T13:00:00.000Z"));
    const served = await caller().portfolio.holdings();
    expect(served.asOf).toBe(NOW.toISOString()); // the OLD statement, honestly aged
    vi.mocked(Date.now).mockRestore();

    holdingsCache.clear();
    depsMock.mockReturnValue(
      fakeDeps({ rpc: () => Promise.reject(new Error("solana rpc down")) }),
    );
    await expect(caller().portfolio.holdings()).rejects.toMatchObject({
      code: "BAD_GATEWAY",
    });
  });

  it("sparklines come from the newest ≤20 snapshots, oldest-first, hidden <2 points", async () => {
    await seedBuy({ assetId: "spyx", usd: 15, qty: 0.05 });
    await db.insert(portfolioSnapshots).values([
      {
        userId,
        totalUsd: 28,
        perAssetJson: { spyx: { qty: 0.05, markUsd: 560, valueUsd: 28 } },
        at: new Date("2026-07-16T09:00:00.000Z"),
      },
      {
        userId,
        totalUsd: 29,
        perAssetJson: { spyx: { qty: 0.05, markUsd: 580, valueUsd: 29 } },
        at: new Date("2026-07-16T10:00:00.000Z"),
      },
      {
        userId,
        totalUsd: 30,
        perAssetJson: { spyx: { qty: 0.05, markUsd: 600, valueUsd: 30 } },
        at: new Date("2026-07-16T11:00:00.000Z"),
      },
    ]);

    const res = await caller().portfolio.holdings();
    expect(res.holdings[0].spark).toEqual([28, 29, 30]);
  });

  it("empty portfolio returns the honest empty statement", async () => {
    depsMock.mockReturnValue(
      fakeDeps({ rpc: () => Promise.resolve({ value: [] }) }),
    );
    const res = await caller().portfolio.holdings();
    expect(res.holdings).toEqual([]);
    expect(res.totalUsd).toBe(0);
    expect(res.returnUsd).toBeNull();
  });
});

describe("portfolio.chart", () => {
  const seedSnapshot = (iso: string, totalUsd: number) =>
    db.insert(portfolioSnapshots).values({
      userId,
      totalUsd,
      perAssetJson: {},
      at: new Date(iso),
    });

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-16T12:30:00.000Z"));
    return () => vi.mocked(Date.now).mockRestore();
  });

  it("1w buckets hourly, last-per-bucket wins, worker gaps stay null", async () => {
    await seedSnapshot("2026-07-16T10:05:00.000Z", 100);
    await seedSnapshot("2026-07-16T10:55:00.000Z", 101);
    await seedSnapshot("2026-07-16T12:05:00.000Z", 103);

    const res = await caller().portfolio.chart({ range: "1w" });
    expect(res.points).toEqual([
      { t: Date.parse("2026-07-16T10:00:00.000Z") / 1000, usd: 101 },
      { t: Date.parse("2026-07-16T11:00:00.000Z") / 1000, usd: null },
      { t: Date.parse("2026-07-16T12:00:00.000Z") / 1000, usd: 103 },
    ]);
  });

  it("range windows filter server-side; 'all' reaches the first snapshot", async () => {
    await seedSnapshot("2026-05-01T00:00:00.000Z", 50); // > 1m ago
    await seedSnapshot("2026-07-16T11:00:00.000Z", 100);

    const oneMonth = await caller().portfolio.chart({ range: "1m" });
    expect(oneMonth.points.some((p) => p.usd === 50)).toBe(false);

    const all = await caller().portfolio.chart({ range: "all" });
    expect(all.points[0].usd).toBe(50);
    expect(all.points.at(-1)?.usd).toBe(100); // today's bucket holds 11:00
    // The 2.5-month worker gap renders as null buckets, never interpolation.
    expect(all.points.filter((p) => p.usd === null).length).toBeGreaterThan(60);
  });

  it("no snapshots → empty points (the chart renders its skeleton/empty state)", async () => {
    const res = await caller().portfolio.chart({ range: "3m" });
    expect(res.points).toEqual([]);
  });
});
