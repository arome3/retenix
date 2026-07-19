import { estates, events, getDb, users } from "@retenix/db";
import { ESTATE_EVENTS } from "@retenix/shared";
import { and, eq, like } from "drizzle-orm";
import { Wallet } from "ethers";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { EstateChainState, EstateOnchain } from "./estate-support";
import { extractActivityTimes, heartbeatTick, observeOwner, type HeartbeatDeps } from "./heartbeat";

/*
 * Heartbeat over a real Postgres, chain + UA edges faked. The DoD line this
 * proves: seeded UA activity → the worker relays checkIn within ONE cycle →
 * the estate.checkin event carries the observation proof (CONFLICTS #13).
 */

const db = getDb();
const PREFIX = "0xheartbeat-test";
const OWNER = Wallet.createRandom().address;

let userId: string;

function chainState(over: Partial<EstateChainState> = {}): EstateChainState {
  return {
    beneficiaryHash: `0x${"ab".repeat(32)}`,
    inactivitySecs: 120n,
    lastCheckIn: BigInt(Math.floor(Date.now() / 1000) - 30),
    claimReadyAt: 0n,
    status: 1, // enrolled
    ...over,
  };
}

function fakeOnchain(over: Partial<EstateOnchain> = {}): EstateOnchain & {
  checkIns: string[];
} {
  const checkIns: string[] = [];
  const onchain: EstateOnchain = {
    estateOf: vi.fn(async () => chainState()),
    checkIn: vi.fn(async (owner: string) => {
      checkIns.push(owner);
      return { txHash: "0xbump" };
    }),
    fireDeadline: vi.fn(async () => ({ txHash: "0xfire" })),
    markClaimed: vi.fn(async () => ({ txHash: "0xmark" })),
    claimedHeir: vi.fn(async () => null),
    ...over,
  };
  return Object.assign(onchain, { checkIns });
}

function deps(over: Partial<HeartbeatDeps> = {}): HeartbeatDeps {
  return {
    db,
    onchain: fakeOnchain(),
    observer: { recentActivity: vi.fn(async () => ({ transactions: [] })) },
    ...over,
  };
}

async function seedEstate(cache: Record<string, unknown> = { status: "enrolled" }) {
  await db.insert(estates).values({
    userId,
    beneficiaryEmailEnc: "{}",
    tuplesEnc: null,
    refreshedAt: new Date(),
    contractStateCache: cache,
  });
}

async function eventRows(type: string) {
  return db
    .select({ payload: events.payloadJson })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.type, type)));
}

async function cleanup() {
  const stale = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.emailHash, `${PREFIX}%`));
  for (const row of stale) {
    await db.delete(estates).where(eq(estates.userId, row.id));
    await db.delete(events).where(eq(events.userId, row.id));
    await db.delete(users).where(eq(users.id, row.id));
  }
}

beforeEach(async () => {
  await cleanup();
  const [row] = await db
    .insert(users)
    .values({
      emailHash: `${PREFIX}-${Date.now()}`,
      eoaAddr: OWNER,
      uaEvmAddr: OWNER,
      uaSolAddr: "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",
      region: "DE",
    })
    .returning({ id: users.id });
  userId = row!.id;
});

afterAll(cleanup);

describe("extractActivityTimes (defensive — the payload shape is unfrozen)", () => {
  it("reads arrays, wrapper keys, ms/sec numbers and ISO strings", () => {
    expect(extractActivityTimes([{ createdAt: 1752700000000 }])).toEqual([1752700000000]);
    expect(extractActivityTimes({ transactions: [{ timestamp: 1752700000 }] })).toEqual([
      1752700000000,
    ]);
    expect(
      extractActivityTimes({ data: { list: [{ updatedAt: "2026-07-17T00:00:00.000Z" }] } }),
    ).toEqual([Date.parse("2026-07-17T00:00:00.000Z")]);
    expect(extractActivityTimes({ list: [{ time: "1752700000" }] })).toEqual([1752700000000]);
  });

  it("garbage contributes nothing (under-report is the safe direction)", () => {
    expect(extractActivityTimes(null)).toEqual([]);
    expect(extractActivityTimes("nope")).toEqual([]);
    expect(extractActivityTimes({ transactions: [{ createdAt: "soon" }, {}] })).toEqual([]);
    expect(extractActivityTimes({ transactions: [{ createdAt: 42 }] })).toEqual([]); // too small
  });
});

describe("observeOwner", () => {
  it("NEW activity → relays checkIn within the cycle + proof on the event (DoD)", async () => {
    await seedEstate({ status: "enrolled", lastObservedTxAt: null });
    const onchain = fakeOnchain();
    // the SAME activity payload on both observations — frozen timestamp
    const activityAt = Date.now() - 5_000;
    const d = deps({
      onchain,
      observer: {
        recentActivity: vi.fn(async () => ({
          transactions: [{ createdAt: activityAt }],
        })),
      },
    });
    const [estate] = await loadEstates();
    const res = await observeOwner(d, estate!);
    expect(res.relayed).toBe(true);
    expect(onchain.checkIns).toEqual([OWNER]);

    const rows = await eventRows(ESTATE_EVENTS.checkin);
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.source).toBe("observed");
    expect((payload.proof as { observedActivityAt: string }).observedActivityAt).toBeTruthy();

    // the watermark advanced — the SAME activity never bumps twice
    const [after] = await loadEstates();
    const res2 = await observeOwner(d, after!);
    expect(res2.relayed).toBe(false);
    expect(onchain.checkIns).toHaveLength(1);
  });

  it("no activity → no relay, cache still refreshed", async () => {
    await seedEstate();
    const onchain = fakeOnchain();
    const [estate] = await loadEstates();
    await observeOwner(deps({ onchain }), estate!);
    expect(onchain.checkIns).toHaveLength(0);
    const [row] = await db
      .select({ cache: estates.contractStateCache })
      .from(estates)
      .where(eq(estates.userId, userId));
    expect((row!.cache as { status: string }).status).toBe("enrolled");
    expect((row!.cache as { updatedAt: string }).updatedAt).toBeTruthy();
  });

  it("records estate.countdown_started ONCE on the enrolled→countdown transition", async () => {
    await seedEstate({ status: "enrolled" });
    const onchain = fakeOnchain({
      estateOf: vi.fn(async () =>
        chainState({ status: 2, claimReadyAt: BigInt(Math.floor(Date.now() / 1000) + 60) }),
      ),
    });
    const d = deps({ onchain });
    const [estate] = await loadEstates();
    await observeOwner(d, estate!);
    expect(await eventRows(ESTATE_EVENTS.countdownStarted)).toHaveLength(1);

    // second cycle: cache now says countdown → no duplicate event
    const [after] = await loadEstates();
    await observeOwner(d, after!);
    expect(await eventRows(ESTATE_EVENTS.countdownStarted)).toHaveLength(1);
  });

  it("mid-countdown activity relays the SAME cancel call (veto by liveness)", async () => {
    await seedEstate({ status: "countdown" });
    const onchain = fakeOnchain({
      estateOf: vi.fn(async () =>
        chainState({ status: 2, claimReadyAt: BigInt(Math.floor(Date.now() / 1000) + 60) }),
      ),
    });
    const d = deps({
      onchain,
      observer: {
        recentActivity: vi.fn(async () => [{ createdAt: Date.now() }]),
      },
    });
    const [estate] = await loadEstates();
    const res = await observeOwner(d, estate!);
    expect(res.relayed).toBe(true);
    const [row] = await db
      .select({ cache: estates.contractStateCache })
      .from(estates)
      .where(eq(estates.userId, userId));
    expect((row!.cache as { status: string }).status).toBe("enrolled");
    expect((row!.cache as { claimReadyAt: string | null }).claimReadyAt).toBeNull();
  });
});

describe("heartbeatTick", () => {
  it("covers every enrolled estate and survives per-owner failures", async () => {
    await seedEstate();
    const onchain = fakeOnchain({
      estateOf: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    });
    await expect(heartbeatTick(deps({ onchain }))).resolves.toBeUndefined();
  });
});

async function loadEstates() {
  return db
    .select({
      userId: estates.userId,
      owner: users.eoaAddr,
      beneficiaryEmailEnc: estates.beneficiaryEmailEnc,
      tuplesEnc: estates.tuplesEnc,
      contractStateCache: estates.contractStateCache,
    })
    .from(estates)
    .innerJoin(users, eq(users.id, estates.userId))
    .where(eq(estates.userId, userId));
}
