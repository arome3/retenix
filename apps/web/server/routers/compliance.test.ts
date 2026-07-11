import { events, getDb, users } from "@retenix/db";
import { COMPLIANCE_EVENTS, COMPLIANCE_QUIZ } from "@retenix/shared";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { GATE_COOKIE } from "@/lib/session";
import type { Context } from "../context";

const { appRouter } = await import("./index");
const db = getDb();

// Correct / wrong-in-Q1 answer index arrays derived from the shared quiz.
const CORRECT = COMPLIANCE_QUIZ.map((q) => q.options.findIndex((o) => o.correct));
const WRONG_Q1 = [...CORRECT];
WRONG_Q1[0] = COMPLIANCE_QUIZ[0].options.findIndex((o) => !o.correct);

const created: string[] = [];

function hex(len: number): string {
  let s = "";
  while (s.length < len) s += Math.floor(Math.random() * 16).toString(16);
  return s.slice(0, len);
}

async function makeUser(): Promise<{ userId: string; eoa: string }> {
  const suffix = hex(8);
  const emailHash = `0xtest${suffix}${"0".repeat(53)}`;
  const eoa = `0xTe${suffix}${"0".repeat(34)}`;
  const [row] = await db
    .insert(users)
    .values({ emailHash, eoaAddr: eoa, uaEvmAddr: "", uaSolAddr: "", region: "" })
    .returning({ id: users.id });
  created.push(row.id);
  return { userId: row.id, eoa };
}

function makeCtx(user: { userId: string; eoa: string }): Context & {
  resHeaders: Headers;
} {
  return {
    db,
    session: {
      userId: user.userId,
      eoaAddr: user.eoa,
      issuer: `did:test:${user.eoa}`,
      region: "",
    },
    headers: new Headers(),
    resHeaders: new Headers(),
  };
}

const caller = (user: { userId: string; eoa: string }) =>
  appRouter.createCaller(makeCtx(user));

async function eventTypes(userId: string): Promise<string[]> {
  const rows = await db
    .select({ type: events.type })
    .from(events)
    .where(eq(events.userId, userId));
  return rows.map((r) => r.type).sort();
}
async function countEvents(userId: string, type: string): Promise<number> {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.type, type)));
  return rows.length;
}
async function regionOf(userId: string): Promise<string> {
  const [row] = await db
    .select({ region: users.region })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row.region;
}

/** Walk the full gate for a user; returns the finalization ctx (for cookies). */
async function passGate(
  user: { userId: string; eoa: string },
  region = "DE",
) {
  await caller(user).compliance.setRegion({ region });
  await caller(user).compliance.submitQuiz({ answers: CORRECT });
  await caller(user).compliance.submitIdentity({ name: "Ada", dob: "1990-01-01" });
  const ctx = makeCtx(user);
  await appRouter.createCaller(ctx).compliance.acknowledgeRisk();
  return ctx;
}

afterEach(async () => {
  for (const id of created.splice(0)) {
    await db.delete(events).where(eq(events.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("compliance.setRegion", () => {
  it("records region_set WITHOUT writing users.region (deferred to finalization)", async () => {
    const user = await makeUser();
    const res = await caller(user).compliance.setRegion({ region: "DE" });

    expect(res).toEqual({ region: "DE", equityEligible: true });
    expect(await regionOf(user.userId)).toBe(""); // column NOT written yet
    expect(await countEvents(user.userId, COMPLIANCE_EVENTS.regionSet)).toBe(1);
  });

  it("reports a restricted region as not equity-eligible", async () => {
    const user = await makeUser();
    const res = await caller(user).compliance.setRegion({ region: "US" });
    expect(res.equityEligible).toBe(false);
  });

  it("rejects an unknown (non-ISO) region code", async () => {
    const user = await makeUser();
    await expect(
      caller(user).compliance.setRegion({ region: "ZZ" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("is immutable: a second, DIFFERENT region is refused (anti gate-shop)", async () => {
    const user = await makeUser();
    await caller(user).compliance.setRegion({ region: "US" });
    await expect(
      caller(user).compliance.setRegion({ region: "DE" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // the original pick stands
    expect(await countEvents(user.userId, COMPLIANCE_EVENTS.regionSet)).toBe(1);
  });

  it("is idempotent: re-submitting the SAME region is a no-op success", async () => {
    const user = await makeUser();
    await caller(user).compliance.setRegion({ region: "DE" });
    await caller(user).compliance.setRegion({ region: "DE" });
    expect(await countEvents(user.userId, COMPLIANCE_EVENTS.regionSet)).toBe(1);
  });

  it("serializes concurrent conflicting picks — exactly one region wins", async () => {
    const user = await makeUser();
    const results = await Promise.allSettled([
      caller(user).compliance.setRegion({ region: "US" }),
      caller(user).compliance.setRegion({ region: "DE" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(await countEvents(user.userId, COMPLIANCE_EVENTS.regionSet)).toBe(1);
  });
});

describe("compliance.submitQuiz", () => {
  it("requires a region first", async () => {
    const user = await makeUser();
    await expect(
      caller(user).compliance.submitQuiz({ answers: CORRECT }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a wrong answer and writes no quiz_passed event", async () => {
    const user = await makeUser();
    await caller(user).compliance.setRegion({ region: "DE" });
    await expect(
      caller(user).compliance.submitQuiz({ answers: WRONG_Q1 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await countEvents(user.userId, COMPLIANCE_EVENTS.quizPassed)).toBe(0);
  });

  it("accepts all-correct answers", async () => {
    const user = await makeUser();
    await caller(user).compliance.setRegion({ region: "DE" });
    await caller(user).compliance.submitQuiz({ answers: CORRECT });
    expect(await countEvents(user.userId, COMPLIANCE_EVENTS.quizPassed)).toBe(1);
  });
});

describe("compliance.acknowledgeRisk (finalization)", () => {
  it("refuses to finalize before the quiz — region stays unset (no half-gate)", async () => {
    const user = await makeUser();
    await caller(user).compliance.setRegion({ region: "DE" });
    await expect(
      caller(user).compliance.acknowledgeRisk(),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await regionOf(user.userId)).toBe("");
  });

  it("refuses to finalize before the identity step", async () => {
    const user = await makeUser();
    await caller(user).compliance.setRegion({ region: "DE" });
    await caller(user).compliance.submitQuiz({ answers: CORRECT });
    await expect(
      caller(user).compliance.acknowledgeRisk(),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await regionOf(user.userId)).toBe("");
  });

  it("writes users.region and all four events, and flips the gate cookie", async () => {
    const user = await makeUser();
    const ctx = await passGate(user, "DE");

    expect(await regionOf(user.userId)).toBe("DE");
    expect(await eventTypes(user.userId)).toEqual(
      [
        COMPLIANCE_EVENTS.identitySimulated,
        COMPLIANCE_EVENTS.quizPassed,
        COMPLIANCE_EVENTS.regionSet,
        COMPLIANCE_EVENTS.riskAcknowledged,
      ].sort(),
    );

    const setCookie = ctx.resHeaders.getSetCookie();
    expect(setCookie.some((c) => c.startsWith(`${GATE_COOKIE}=1`))).toBe(true);
  });

  it("a restricted region still finalizes (blocked users are customers)", async () => {
    const user = await makeUser();
    await passGate(user, "US");
    expect(await regionOf(user.userId)).toBe("US");
  });
});

describe("gate steps are idempotent / re-submittable", () => {
  it("re-running every completed step is a no-op success with no duplicate rows", async () => {
    const user = await makeUser();
    await passGate(user, "DE");

    // Re-run each step; nothing should throw, nothing should duplicate.
    await caller(user).compliance.setRegion({ region: "DE" });
    await caller(user).compliance.submitQuiz({ answers: CORRECT });
    await caller(user).compliance.submitIdentity({ name: "Ada", dob: "1990-01-01" });
    await caller(user).compliance.acknowledgeRisk();

    expect(await regionOf(user.userId)).toBe("DE");
    for (const type of Object.values(COMPLIANCE_EVENTS)) {
      expect(await countEvents(user.userId, type)).toBe(1);
    }
  });
});

describe("gatedProcedure (deep-link layer 2) — account.summary", () => {
  it("FORBIDs a region-less session, then lets a gated one through", async () => {
    const user = await makeUser();

    // Pre-gate: the DB region is "", so the gate layer refuses before the stub runs.
    await expect(caller(user).account.summary()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    await passGate(user, "DE");

    // Post-gate: the layer lets it through to the (module-06) stub.
    await expect(caller(user).account.summary()).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });
});
