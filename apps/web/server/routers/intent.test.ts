import { events, getDb, users } from "@retenix/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParseOutcome } from "../lib/draft";
import { __resetIntentRateLimit } from "../lib/intent-rate-limit";
import type { Context } from "../context";

// The route is exercised for real — only the model edge is stubbed, one
// outcome per test (the deterministic pipeline underneath is NOT mocked).
const parseIntentMock = vi.fn<() => Promise<ParseOutcome>>();
vi.mock("../lib/parse-intent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/parse-intent")>();
  return { ...actual, parseIntent: (...args: unknown[]) => parseIntentMock(...(args as [])) };
});

const { appRouter } = await import("./index");
const db = getDb();

const created: string[] = [];

function hex(len: number): string {
  let s = "";
  while (s.length < len) s += Math.floor(Math.random() * 16).toString(16);
  return s.slice(0, len);
}

async function makeUser(region: string): Promise<{ userId: string; eoa: string }> {
  const suffix = hex(8);
  const emailHash = `0xtest${suffix}${"0".repeat(53)}`;
  const eoa = `0xTe${suffix}${"0".repeat(34)}`;
  const [row] = await db
    .insert(users)
    .values({ emailHash, eoaAddr: eoa, uaEvmAddr: "", uaSolAddr: "", region })
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
  } as Context & { resHeaders: Headers };
}

const caller = (user: { userId: string; eoa: string }) =>
  appRouter.createCaller(makeCtx(user));

async function intentEvents(userId: string) {
  return db
    .select({ payloadJson: events.payloadJson })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.type, "intent.parsed")));
}

async function allEventTypes(userId: string): Promise<string[]> {
  const rows = await db
    .select({ type: events.type })
    .from(events)
    .where(eq(events.userId, userId));
  return rows.map((r) => r.type);
}

const CANONICAL_RAW = {
  broker: {
    cadence: "weekly",
    amountUsd: 25,
    basket: [
      { assetId: "spyx", pct: 60 },
      { assetId: "tslax", pct: 30 },
      { assetId: "sol", pct: 10 },
    ],
  },
  guardian: { maxDrawdownPct: 15 },
};

const CANONICAL_TEXT =
  "Invest $25 every week: 60% SPYx, 30% TSLAx, 10% SOL. Stop if I'm down 15%.";

beforeEach(() => {
  __resetIntentRateLimit();
  parseIntentMock.mockReset();
});

afterEach(async () => {
  for (const id of created.splice(0)) {
    await db.delete(events).where(eq(events.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("intent.parse — gate and input walls", () => {
  it("is FORBIDDEN before the eligibility gate (region unset)", async () => {
    const user = await makeUser("");
    await expect(
      caller(user).intent.parse({ text: "Invest $25 weekly into SOL" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(parseIntentMock).not.toHaveBeenCalled();
  });

  it("rejects input over 500 chars before any model call", async () => {
    const user = await makeUser("DE");
    await expect(
      caller(user).intent.parse({ text: "x".repeat(501) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(parseIntentMock).not.toHaveBeenCalled();
  });

  it("rate-limits the 11th parse in a minute (PROPOSED 10/min/user)", async () => {
    const user = await makeUser("DE");
    parseIntentMock.mockResolvedValue({ kind: "output", raw: {} });
    for (let i = 0; i < 10; i++) {
      await caller(user).intent.parse({ text: "hello" });
    }
    await expect(
      caller(user).intent.parse({ text: "hello" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(parseIntentMock).toHaveBeenCalledTimes(10);
  });
});

describe("intent.parse — draft path", () => {
  it("returns the contract shape and writes exactly one intent.parsed event", async () => {
    const user = await makeUser("DE");
    parseIntentMock.mockResolvedValue({ kind: "output", raw: CANONICAL_RAW });

    const res = await caller(user).intent.parse({ text: CANONICAL_TEXT });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.confidenceNote).toBe("Here's what I understood — check the numbers");
    expect(res.adviceFooter).toBe(false); // every final pct is stated verbatim
    expect(res.draft).toEqual(CANONICAL_RAW);
    expect(res.draftId).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await intentEvents(user.userId);
    expect(rows).toHaveLength(1);
    const payload = rows[0].payloadJson as {
      draftId: string;
      utterance: string;
      parsedAt: string;
      outcome: string;
    };
    expect(payload.draftId).toBe(res.draftId);
    expect(payload.utterance).toBe(CANONICAL_TEXT);
    expect(Number.isNaN(Date.parse(payload.parsedAt))).toBe(false);
    expect(payload.outcome).toBe("draft");

    // The parse writes intent.parsed and NOTHING else (PS-F3-AC2 posture).
    expect(await allEventTypes(user.userId)).toEqual(["intent.parsed"]);
  });

  it("US user: an equity leg is dropped, never rendered (docs 04/05)", async () => {
    const user = await makeUser("US");
    parseIntentMock.mockResolvedValue({
      kind: "output",
      raw: {
        broker: {
          cadence: "weekly",
          amountUsd: 25,
          basket: [
            { assetId: "spyx", pct: 60 },
            { assetId: "sol", pct: 40 },
          ],
        },
      },
    });

    const res = await caller(user).intent.parse({ text: "SPYx and SOL, $25/wk" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.broker?.basket).toEqual([{ assetId: "sol", pct: 100 }]);
  });

  it("sets the advice footer on a model-proposed basket (PS-10.7)", async () => {
    const user = await makeUser("DE");
    parseIntentMock.mockResolvedValue({
      kind: "output",
      raw: {
        broker: {
          cadence: "weekly",
          amountUsd: 25,
          basket: [
            { assetId: "spyx", pct: 70 },
            { assetId: "tslax", pct: 30 },
          ],
        },
      },
    });

    const res = await caller(user).intent.parse({
      text: "Invest $25 a week — mostly S&P, some Tesla.",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.adviceFooter).toBe(true);
  });
});

describe("intent.parse — decline paths (never a stack trace)", () => {
  it("empty object {} → canonical graceful decline + a decline event", async () => {
    const user = await makeUser("DE");
    parseIntentMock.mockResolvedValue({ kind: "output", raw: {} });

    const res = await caller(user).intent.parse({ text: "what's up" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.decline.message).toBe(
      "I didn't want to guess. Try: 'Invest $25 weekly into SPYx and SOL, stop if I'm down 15%.'",
    );
    expect(res.decline.suggestions.length).toBeGreaterThan(0);

    const rows = await intentEvents(user.userId);
    expect(rows).toHaveLength(1);
    expect((rows[0].payloadJson as { outcome: string }).outcome).toBe("decline");
  });

  it("mocked NoObjectGeneratedError path → re-prompt decline, NO event", async () => {
    const user = await makeUser("DE");
    parseIntentMock.mockResolvedValue({ kind: "no-object" });

    const res = await caller(user).intent.parse({ text: "garble" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.decline.suggestions.length).toBeGreaterThan(0);
    expect(await intentEvents(user.userId)).toHaveLength(0);
  });

  it("mocked 15 s timeout path → manual-fallback decline, NO event", async () => {
    const user = await makeUser("DE");
    parseIntentMock.mockResolvedValue({ kind: "unavailable" });

    const res = await caller(user).intent.parse({ text: "invest $25 weekly" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.decline.message).toContain("build it by hand");
    expect(await intentEvents(user.userId)).toHaveLength(0);
  });
});
