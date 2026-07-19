import { randomUUID } from "node:crypto";
import { events, getDb, users } from "@retenix/db";
import { UI_EVENTS } from "@retenix/shared";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Context } from "../context";
import { __resetTelemetryRateLimit, TELEMETRY_RATE_LIMIT } from "../lib/telemetry-rate-limit";
import { appRouter } from "./index";

const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL must be set in CI — db tests may not be skipped");
}

const db = getDb();

describe.skipIf(!url)("telemetry router (PS-8.2)", () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();

  const ctx = (id = userId): Context & { resHeaders: Headers } => ({
    db,
    session: {
      userId: id,
      eoaAddr: `0xtel${id}`,
      issuer: `did:ethr:${id}`,
      region: "NG",
    },
    headers: new Headers(),
    resHeaders: new Headers(),
  });

  const caller = (id = userId) => appRouter.createCaller(ctx(id));
  const rows = (type: string, sid: string) =>
    db
      .select({ id: events.id, userId: events.userId, payload: events.payloadJson })
      .from(events)
      .where(and(eq(events.type, type), sql`${events.payloadJson}->>'sid' = ${sid}`));

  beforeEach(async () => {
    __resetTelemetryRateLimit();
    for (const id of [userId, otherUserId]) {
      await db.insert(users).values({
        id,
        emailHash: `tel-${id}`,
        eoaAddr: `0xtel${id}`,
        uaEvmAddr: "",
        uaSolAddr: "",
        region: "NG",
      }).onConflictDoNothing();
    }
  });

  afterAll(async () => {
    for (const id of [userId, otherUserId]) {
      await db.delete(events).where(eq(events.userId, id));
      await db.delete(users).where(eq(users.id, id));
    }
  });

  it("writes one row per (session, surface)", async () => {
    const sid = randomUUID();
    expect(await caller().telemetry.sourceNamed({ sid, surface: "breakdown" }))
      .toMatchObject({ ok: true, deduped: false });
    expect(await caller().telemetry.sourceNamed({ sid, surface: "breakdown" }))
      .toMatchObject({ ok: true, deduped: true });
    expect(await rows(UI_EVENTS.networkNamed, sid)).toHaveLength(1);
  });

  it("counts surfaces separately within one session", async () => {
    const sid = randomUUID();
    await caller().telemetry.sourceNamed({ sid, surface: "breakdown" });
    await caller().telemetry.sourceNamed({ sid, surface: "withdraw" });
    expect(await rows(UI_EVENTS.networkNamed, sid)).toHaveLength(2);
  });

  it("attributes the row to the SESSION's user, never the input", async () => {
    const sid = randomUUID();
    await caller(otherUserId).telemetry.sourceNamed({ sid, surface: "kill" });
    const [row] = await rows(UI_EVENTS.networkNamed, sid);
    expect(row?.userId).toBe(otherUserId);
  });

  it("stores only {sid, surface} — no PII, no path", async () => {
    const sid = randomUUID();
    await caller().telemetry.sourceNamed({ sid, surface: "receipt" });
    const [row] = await rows(UI_EVENTS.networkNamed, sid);
    expect(Object.keys(row?.payload as object).sort()).toEqual(["sid", "surface"]);
  });

  // THE test. server/trpc.ts's assertGatePassed reads this same table for
  // compliance.quiz_passed and feeds the payload into leverage unlocking, so a
  // telemetry route that let a caller choose `type` would be privilege
  // escalation. The enum + .strict() + server-side literal are the wall.
  it("cannot be made to write any type other than its own", async () => {
    const sid = randomUUID();
    await expect(
      caller().telemetry.sourceNamed({
        sid,
        surface: "receipt",
        type: "compliance.quiz_passed",
      } as never),
    ).rejects.toThrow();
    await expect(
      caller().telemetry.sourceNamed({ sid, surface: "compliance" } as never),
    ).rejects.toThrow();

    const written = await db
      .select({ type: events.type })
      .from(events)
      .where(eq(events.userId, userId));
    for (const row of written) {
      expect(Object.values(UI_EVENTS) as string[]).toContain(row.type);
    }
  });

  it("rejects a malformed sid", async () => {
    await expect(
      caller().telemetry.sourceNamed({ sid: "not-a-uuid", surface: "receipt" }),
    ).rejects.toThrow();
  });

  it("requires a session", async () => {
    const anon = appRouter.createCaller({ ...ctx(), session: null });
    await expect(
      anon.telemetry.sourceNamed({ sid: randomUUID(), surface: "receipt" }),
    ).rejects.toThrow();
  });

  it("sessionStarted is idempotent per session", async () => {
    const sid = randomUUID();
    expect(await caller().telemetry.sessionStarted({ sid })).toMatchObject({ deduped: false });
    expect(await caller().telemetry.sessionStarted({ sid })).toMatchObject({ deduped: true });
    expect(await rows(UI_EVENTS.sessionStarted, sid)).toHaveLength(1);
  });

  // Telemetry must never produce a client-visible error: a throw here would
  // surface as an unhandled rejection in a component that only wanted to count.
  it("returns ok:false over the rate limit rather than throwing", async () => {
    const sid = randomUUID();
    for (let i = 0; i < TELEMETRY_RATE_LIMIT; i++) {
      await caller().telemetry.sessionStarted({ sid: randomUUID() });
    }
    await expect(caller().telemetry.sourceNamed({ sid, surface: "sweep" }))
      .resolves.toMatchObject({ ok: false });
  });

  it("its rows never reach the activity feed", async () => {
    const sid = randomUUID();
    await caller().telemetry.sourceNamed({ sid, surface: "breakdown" });
    const feed = await caller().activity.feed({ filter: "all", limit: 30 });
    const texts = JSON.stringify(feed);
    expect(texts).not.toContain(UI_EVENTS.networkNamed);
    expect(texts).not.toContain(sid);
  });
});
