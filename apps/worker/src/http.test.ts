import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executions, getDb, getPool, jobs, plans, users, type Db } from "@retenix/db";

import { env } from "../env";
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

  // doc 17: /healthz and /internal/health are deliberately NOT the same route.
  // Railway's deploy probe cannot send a header, so the probe target must stay
  // unauthenticated — and an unauthenticated endpoint must not publish queue
  // depth, cron state, and provider reachability. This pins the split.
  describe("/internal/health (doc 17)", () => {
    const get = (base: string, path: string, token?: string, headers = {}) =>
      fetch(`${base}${path}`, {
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      });

    it("healthz stays dependency-free — it must not grow a body", async () => {
      expect(await (await fetch(`${prodBase}/healthz`)).json()).toEqual({ ok: true });
    });

    it("rejects missing and wrong tokens (401)", async () => {
      expect((await get(demoBase, "/internal/health")).status).toBe(401);
      expect((await get(demoBase, "/internal/health", "wrong-token")).status).toBe(401);
    });

    it("503s when no collector is wired, rather than 404ing", async () => {
      // These servers are built without `health` — the honest answer is "I
      // cannot tell you", not "this endpoint does not exist".
      const res = await get(demoBase, "/internal/health", TOKEN);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false });
    });

    it("200 when healthy, 503 when degraded", async () => {
      for (const [ok, status] of [
        [true, 200],
        [false, 503],
      ] as const) {
        const server = createInternalServer({
          db,
          boss,
          demoMode: false,
          health: { collect: async () => ({ ok, degraded: ok ? [] : ["rpc: down"] }) },
        });
        await new Promise<void>((r) => server.listen(0, r));
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const res = await get(base, "/internal/health", TOKEN);
        expect(res.status).toBe(status);
        expect(await res.json()).toMatchObject({ ok });
        server.close();
      }
    });
  });

  // TS-13.2's enforceable half. Railway's public edge sets x-forwarded-for; a
  // caller on the private network does not. The worker still needs public
  // ingress for Alchemy's webhooks, so this fences /internal/* specifically.
  describe("public-edge lockdown (INTERNAL_ROUTES_PRIVATE_ONLY, TS-13.2)", () => {
    const FORWARDED = { "x-forwarded-for": "203.0.113.7" };

    afterAll(() => {
      env.INTERNAL_ROUTES_PRIVATE_ONLY = "0";
    });

    it("is off by default, so staging and dev are unchanged", async () => {
      env.INTERNAL_ROUTES_PRIVATE_ONLY = "0";
      const res = await fetch(`${demoBase}/internal/execute-now`, {
        method: "POST",
        headers: { "content-type": "application/json", ...FORWARDED },
        body: JSON.stringify({ planId }),
      });
      expect(res.status).not.toBe(404); // 401 — reached the auth check
    });

    it("404s an /internal/* request that arrived through the public edge", async () => {
      env.INTERNAL_ROUTES_PRIVATE_ONLY = "1";
      const res = await fetch(`${demoBase}/internal/execute-now`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
          ...FORWARDED,
        },
        body: JSON.stringify({ planId }),
      });
      // 404 and not 403, even WITH a valid token: the same posture as the rogue
      // route — it leaks nothing about what is behind it.
      expect(res.status).toBe(404);
    });

    it("still serves a caller with no forwarding header (private network)", async () => {
      env.INTERNAL_ROUTES_PRIVATE_ONLY = "1";
      const res = await fetch(`${demoBase}/internal/health`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(503); // reached the handler; no collector wired
    });

    it("never fences /healthz — Railway's probe comes through the edge", async () => {
      env.INTERNAL_ROUTES_PRIVATE_ONLY = "1";
      const res = await fetch(`${demoBase}/healthz`, { headers: FORWARDED });
      expect(res.status).toBe(200);
    });

    it("never fences the Alchemy webhook — it originates on the internet", async () => {
      // Asserted as "the fence changes nothing here" rather than against a
      // fixed status: these fixtures carry no estateWebhook, so the route 404s
      // for its own reason, and a status assertion would pass for the wrong one.
      const call = () =>
        fetch(`${demoBase}/webhooks/alchemy`, {
          method: "POST",
          headers: { "content-type": "application/json", ...FORWARDED },
          body: "{}",
        }).then((r) => r.status);

      env.INTERNAL_ROUTES_PRIVATE_ONLY = "0";
      const unfenced = await call();
      env.INTERNAL_ROUTES_PRIVATE_ONLY = "1";
      expect(await call()).toBe(unfenced);
    });
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
