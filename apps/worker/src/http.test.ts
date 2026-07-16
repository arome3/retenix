import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executions, getDb, getPool, jobs, plans, users, type Db } from "@retenix/db";

import type { BossLike } from "./ctx";
import { createInternalServer } from "./http";

const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL must be set in CI — db tests may not be skipped");
}

const TOKEN = "internal-test-token"; // injected by the vitest worker project env

describe.skipIf(!url)("internal HTTP surface", () => {
  let db: Db;
  const userId = randomUUID();
  const planId = randomUUID();
  const boss: BossLike = { send: () => Promise.resolve("q") };

  let demoServer: Server;
  let prodServer: Server;
  let demoBase: string;
  let prodBase: string;

  beforeAll(async () => {
    db = getDb();
    await db.insert(users).values({
      id: userId,
      emailHash: `http-${userId}`,
      eoaAddr: `0xhttp${userId}`,
      uaEvmAddr: "0x0000000000000000000000000000000000000000",
      uaSolAddr: "So11111111111111111111111111111111111111112",
      region: "NG",
    });
    await db.insert(plans).values({
      id: planId,
      userId,
      kind: "broker",
      status: "active",
      contractPlanId: 7,
      activatedAt: new Date("2026-07-13T09:00:00.000Z"),
      paramsJson: {
        cadence: "daily",
        amountUsd: 2,
        basket: [{ assetId: "sol", pct: 100 }],
        capPerExecUsd: 50,
        capPerPeriodUsd: 50,
        periodSecs: 86_400,
        nextRunAt: "2026-07-17T09:00:00.000Z",
      },
    });

    demoServer = createInternalServer({ db, boss, demoMode: true });
    prodServer = createInternalServer({ db, boss, demoMode: false });
    await new Promise<void>((r) => demoServer.listen(0, r));
    await new Promise<void>((r) => prodServer.listen(0, r));
    demoBase = `http://127.0.0.1:${(demoServer.address() as AddressInfo).port}`;
    prodBase = `http://127.0.0.1:${(prodServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    demoServer?.close();
    prodServer?.close();
    await db
      .delete(executions)
      .where(
        inArray(
          executions.jobId,
          db.select({ id: jobs.id }).from(jobs).where(eq(jobs.planId, planId)),
        ),
      );
    await db.delete(jobs).where(eq(jobs.planId, planId));
    await db.delete(plans).where(eq(plans.id, planId));
    await db.delete(users).where(eq(users.id, userId));
    await getPool().end();
  });

  const post = (base: string, path: string, body: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it("healthz answers without auth", async () => {
    const res = await fetch(`${demoBase}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("execute-now rejects missing and wrong tokens (401)", async () => {
    expect((await post(demoBase, "/internal/execute-now", { planId })).status).toBe(401);
    expect(
      (await post(demoBase, "/internal/execute-now", { planId }, "wrong-token")).status,
    ).toBe(401);
  });

  it("execute-now validates the body (400) and unknown plans (404)", async () => {
    expect(
      (await post(demoBase, "/internal/execute-now", { nope: 1 }, TOKEN)).status,
    ).toBe(400);
    expect(
      (await post(demoBase, "/internal/execute-now", { planId: "not-a-uuid" }, TOKEN))
        .status,
    ).toBe(400);
    expect(
      (await post(demoBase, "/internal/execute-now", { planId: randomUUID() }, TOKEN))
        .status,
    ).toBe(404);
  });

  it("execute-now enqueues the current period (202) idempotently", async () => {
    const res = await post(demoBase, "/internal/execute-now", { planId }, TOKEN);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobIds: string[] };
    expect(body.jobIds).toHaveLength(1);

    const again = await post(demoBase, "/internal/execute-now", { planId }, TOKEN);
    expect(((await again.json()) as { jobIds: string[] }).jobIds).toEqual(body.jobIds);
  });

  it("the rogue endpoint does not exist outside DEMO_MODE (404 even with auth)", async () => {
    const res = await post(prodBase, "/internal/demo/rogue", { planId }, TOKEN);
    expect(res.status).toBe(404);
  });

  it("rogue (demo mode) enqueues a :rogue: job (202)", async () => {
    const res = await post(demoBase, "/internal/demo/rogue", { planId }, TOKEN);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; periodKey: string };
    expect(body.periodKey).toContain(":rogue:");
  });

  it("unknown paths 404", async () => {
    expect((await post(demoBase, "/internal/anything", { planId }, TOKEN)).status).toBe(
      404,
    );
    expect((await fetch(`${demoBase}/internal/execute-now`)).status).toBe(404); // GET
  });
});
