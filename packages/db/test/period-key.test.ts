import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, getPool, jobs, plans, users } from "../src";

// Execution idempotency (doc 08) hangs on jobs_period_key_uq — prove the
// unique index rejects a duplicate period_key. Needs a live Postgres with the
// schema pushed (`pnpm db:push`): soft-skip locally without DATABASE_URL,
// hard-fail in CI where the postgres service must be present.
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL must be set in CI — db tests may not be skipped");
}
if (!url) {
  console.warn(
    "[db] DATABASE_URL not set — skipping jobs_period_key_uq test (start Postgres, set DATABASE_URL in the root .env, run pnpm db:push)",
  );
}

describe.skipIf(!url)("jobs_period_key_uq", () => {
  const userId = randomUUID();
  const planId = randomUUID();
  const periodKey = `${planId}:2026-07-01:0`;

  beforeAll(async () => {
    const db = getDb();
    await db.insert(users).values({
      id: userId,
      emailHash: `test-${userId}`,
      eoaAddr: `0xtest${userId}`,
      uaEvmAddr: "0x0000000000000000000000000000000000000000",
      uaSolAddr: "So11111111111111111111111111111111111111112",
      region: "NG",
    });
    await db.insert(plans).values({
      id: planId,
      userId,
      kind: "broker",
      paramsJson: {},
    });
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(jobs).where(eq(jobs.planId, planId));
    await db.delete(plans).where(eq(plans.id, planId));
    await db.delete(users).where(eq(users.id, userId));
    await getPool().end();
  });

  it("rejects a second insert with the same period_key", async () => {
    const db = getDb();
    const row = { planId, runAt: new Date(), periodKey };

    await db.insert(jobs).values(row);

    // drizzle wraps the pg error; the constraint name lives in the cause chain.
    const err: unknown = await db
      .insert(jobs)
      .values(row)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const chain = `${String(err)} ${String((err as Error).cause ?? "")}`;
    expect(chain).toMatch(/jobs_period_key_uq|duplicate key/);
  });
});
