import { events, getDb, plans, users } from "@retenix/db";
import { REGISTRY } from "@retenix/registry";
import {
  KILL_EVENTS,
  buildSignedMessage,
  computeInputHash,
  type KillExecutePayload,
  type KillLegPayload,
  type KillReceiptPayload,
  type KillRetryLegPayload,
  type SigEnvelope,
} from "@retenix/shared";
import { pollToTerminal } from "@retenix/ua";
import { and, eq, inArray } from "drizzle-orm";
import { Wallet } from "ethers";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import type { PlanRelay } from "../lib/relay-factory";

/*
 * kill.* route behavior over a real Postgres, network edges mocked: position
 * enumeration (lib/holdings), the UA layer (@retenix/ua), and the relay
 * (setPlanRelayFactory). Signed envelopes are real ethers signatures — the
 * sweep.test.ts conventions throughout.
 */

vi.mock("../lib/holdings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/holdings")>();
  return {
    ...actual,
    enumeratePositions: vi.fn(),
    defaultHoldingsDeps: vi.fn(() => ({
      rpc: vi.fn(),
      fetchImpl: vi.fn(),
      now: () => new Date(),
    })),
    marksSource: vi.fn(() => "last-trade" as const),
  };
});
vi.mock("@retenix/ua", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@retenix/ua")>();
  return {
    ...actual,
    createUa: vi.fn(() => ({}) as never),
    getPrimaryAssets: vi.fn(),
    pollToTerminal: vi.fn(),
  };
});

const holdings = await import("../lib/holdings");
const enumerateMock = vi.mocked(holdings.enumeratePositions);
const ua = await import("@retenix/ua");
const primariesMock = vi.mocked(ua.getPrimaryAssets);
const pollMock = vi.mocked(pollToTerminal);
const { setPlanRelayFactory, resetPlanRelayFactory } = await import(
  "../lib/relay-factory"
);
const { appRouter } = await import("./index");

const db = getDb();
const wallet = Wallet.createRandom();
const EMAIL_HASH = "0xkill-route-test-emailhash";
const SPYX = REGISTRY.find((a) => a.id === "spyx")!;
const TSLAX = REGISTRY.find((a) => a.id === "tslax")!;

let userId: string;

const ctx = (): Context => ({
  db,
  session: { userId, eoaAddr: wallet.address, issuer: "did:test", region: "DE" },
  headers: new Headers(),
  resHeaders: new Headers(),
});

const caller = () => appRouter.createCaller(ctx());

let nonceCounter = Date.now();
const nextNonce = () => ++nonceCounter;

async function sign(route: string, payload: unknown): Promise<SigEnvelope> {
  const nonce = nextNonce();
  const expiry = Math.floor(Date.now() / 1000) + 240;
  const message = buildSignedMessage({
    route,
    inputHash: computeInputHash(payload),
    nonce,
    expiry,
  });
  return { signature: await wallet.signMessage(message), nonce, expiry };
}

async function execute(payload: KillExecutePayload = { revokeAllAuth: AUTH }) {
  return caller().kill.execute({
    payload,
    sig: await sign("kill.execute", payload),
  });
}

async function retryLeg(payload: KillRetryLegPayload) {
  return caller().kill.retryLeg({
    payload,
    sig: await sign("kill.retryLeg", payload),
  });
}

const AUTH = { nonce: "7", signature: `0x${"ab".repeat(65)}` };

/** Relay double: records call order, configurable failure. */
function killStubRelay(over: Partial<PlanRelay> = {}) {
  const calls: string[] = [];
  const relay: PlanRelay = {
    domain: { chainId: 421614, contract: "0x4549a91b4727537372925C8C589d9BCfF9B6c261" },
    authNonce: async () => {
      calls.push("authNonce");
      return 7n;
    },
    agentAddress: async () => "0x562937835cdD5C92F54B94Df658Fd3b50A68ecD5",
    buildCreatePlanDigest: async () => `0x${"cd".repeat(32)}`,
    createPlan: async () => ({ txHash: "0xtx", planId: 42n }),
    revokePlanFor: async () => ({ txHash: "0xrevoke" }),
    verifyRevokeAll: () => {
      calls.push("verifyRevokeAll");
      return true;
    },
    revokeAll: async () => {
      calls.push("revokeAll");
      return { txHash: "0xrevokeall" };
    },
    txStatus: async () => {
      calls.push("txStatus");
      return "confirmed" as const;
    },
    // module 14 surface — unused by kill.*, present to satisfy the interface
    enrollEstate: async () => ({ txHash: "0xenroll" }),
    checkIn: async () => ({ txHash: "0xcheckin" }),
    estateOf: async () => ({
      beneficiaryHash: `0x${"00".repeat(32)}`,
      inactivitySecs: 0n,
      lastCheckIn: 0n,
      claimReadyAt: 0n,
      status: 0,
    }),
    ...over,
  };
  return Object.assign(relay, { calls });
}

const POSITIONS = {
  positions: [
    { assetId: "spyx", qty: 0.05, qtyHuman: "0.05" },
    { assetId: "tslax", qty: 0.1, qtyHuman: "0.1" },
  ],
  fills: { fills: [], unattributed: 0 },
};

const PRIMARIES = {
  assets: [
    {
      tokenType: "eth",
      amountInUSD: 10,
      chainAggregation: [{ amountInUSD: 10, token: { chainId: 42161 } }],
    },
    { tokenType: "usdc", amountInUSD: 55, chainAggregation: [] },
  ],
  totalAmountInUSD: 65,
} as never;

async function seedPlans() {
  const rows = await db
    .insert(plans)
    .values([
      { userId, kind: "broker", paramsJson: {}, contractPlanId: 42, status: "active" },
      { userId, kind: "guardian", paramsJson: {}, contractPlanId: 42, status: "paused" },
      { userId, kind: "legacy", paramsJson: {}, contractPlanId: null, status: "active" },
    ])
    .returning({ id: plans.id, kind: plans.kind });
  return rows;
}

async function eventRows(type: string) {
  return db
    .select({ id: events.id, payloadJson: events.payloadJson })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.type, type)));
}

async function legRows(): Promise<KillLegPayload[]> {
  return (await eventRows(KILL_EVENTS.leg)).map((r) => r.payloadJson as KillLegPayload);
}

/** A FINISHED UA payload showing `address` leaving this account. */
const finishedT = (address: string, over: Record<string, unknown> = {}) => ({
  status: 7,
  smartAccountOptions: { ownerAddress: wallet.address },
  tokenChanges: {
    decr: [{ token: { address }, amount: "0.05", amountInUSD: "32.11" }],
  },
  ...over,
});

const polled = (outcome: "finished" | "refunded" | "timeout", t: object) =>
  ({ outcome, t: { status: 7, ...t } }) as never;

async function cleanup() {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.emailHash, [EMAIL_HASH, `${EMAIL_HASH}-other`]));
  for (const row of rows) {
    await db.delete(events).where(eq(events.userId, row.id));
    await db.delete(plans).where(eq(plans.userId, row.id));
    await db.delete(users).where(eq(users.id, row.id));
  }
}

beforeEach(async () => {
  await cleanup();
  enumerateMock.mockReset();
  primariesMock.mockReset();
  pollMock.mockReset();
  enumerateMock.mockResolvedValue(POSITIONS as never);
  primariesMock.mockResolvedValue(PRIMARIES);
  setPlanRelayFactory(() => killStubRelay());
  const [row] = await db
    .insert(users)
    .values({
      emailHash: EMAIL_HASH,
      eoaAddr: wallet.address,
      uaEvmAddr: wallet.address,
      uaSolAddr: "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",
      region: "DE",
    })
    .returning({ id: users.id });
  userId = row.id;
});
afterAll(async () => {
  resetPlanRelayFactory();
  await cleanup();
});

// ---------------------------------------------------------------------------
// kill.execute
// ---------------------------------------------------------------------------

describe("kill.execute", () => {
  it("plans 2 sells + 1 convert, revokes FIRST, flips broker/guardian, never legacy", async () => {
    const seeded = await seedPlans();
    const relay = killStubRelay();
    setPlanRelayFactory(() => relay);

    const res = await execute();

    // Sequencing: the relay fired before the mutation resolved a single work
    // item (the browser can only send legs after this response).
    expect(relay.calls).toContain("revokeAll");
    expect(res.revoke).toEqual({ state: "submitted", txHash: "0xrevokeall" });
    expect(res.workItems).toHaveLength(3);
    expect(res.workItems.map((w) => w.assetId)).toEqual(["spyx", "tslax", "eth"]);
    expect(res.workItems[0].amountHuman).toBe("0.05");
    expect(res.workItems[2]).toMatchObject({
      kind: "convert",
      expectUsdc: 9.8,
      primaryType: "eth",
    });

    // DB statuses: broker+guardian revoked, legacy untouched (estate is
    // cancelled only via its own card — doc 14).
    const after = await db
      .select({ kind: plans.kind, status: plans.status })
      .from(plans)
      .where(eq(plans.userId, userId));
    expect(after.find((p) => p.kind === "broker")?.status).toBe("revoked");
    expect(after.find((p) => p.kind === "guardian")?.status).toBe("revoked");
    expect(after.find((p) => p.kind === "legacy")?.status).toBe("active");

    // plan.revoked receipts for the two flipped cards (module 10's record).
    const revokedEvents = await eventRows("plan.revoked");
    expect(revokedEvents).toHaveLength(2);

    // Legs persisted pending with outcome from birth (fills contract).
    const legs = await legRows();
    expect(legs).toHaveLength(3);
    expect(legs.every((l) => l.outcome === "pending")).toBe(true);
    expect(seeded.filter((p) => p.kind !== "legacy")).toHaveLength(2);
  });

  it("is idempotent: a second execute converges on the same killId, no duplicate rows", async () => {
    await seedPlans();
    const first = await execute();
    const second = await execute();

    expect(second.killId).toBe(first.killId);
    expect(second.resumed).toBe(true);
    expect(second.workItems).toHaveLength(3); // all still pending → still work
    expect(await eventRows(KILL_EVENTS.started)).toHaveLength(1);
    expect(await legRows()).toHaveLength(3);
    expect(await eventRows("plan.revoked")).toHaveLength(2);
    // The converging call must NOT double-spend the relay nonce.
    expect(enumerateMock).toHaveBeenCalledTimes(2); // scan runs, plan discarded
  });

  it("relay failure = continue-and-report: legs still returned, revoke failed, plans still flipped", async () => {
    await seedPlans();
    setPlanRelayFactory(() =>
      killStubRelay({
        revokeAll: async () => {
          throw new Error("relayer unfunded");
        },
      }),
    );

    const res = await execute();
    expect(res.revoke.state).toBe("failed");
    expect(res.workItems).toHaveLength(3);
    const after = await db
      .select({ kind: plans.kind, status: plans.status })
      .from(plans)
      .where(and(eq(plans.userId, userId), eq(plans.kind, "broker")));
    expect(after[0].status).toBe("revoked"); // the worker stops regardless
  });

  it("zero onchain plans: no auth needed, relay never called, revoked immediately", async () => {
    const relay = killStubRelay();
    setPlanRelayFactory(() => relay);
    const res = await execute({});
    expect(res.revoke.state).toBe("confirmed");
    expect(relay.calls).not.toContain("revokeAll");
    expect(res.workItems).toHaveLength(3);
  });

  it("zero legs (all-USDC account): aggregate written in the same flow, next execute starts fresh", async () => {
    enumerateMock.mockResolvedValue({ positions: [], fills: { fills: [], unattributed: 0 } } as never);
    primariesMock.mockResolvedValue({ assets: [{ tokenType: "usdc", amountInUSD: 55 }] } as never);

    const first = await execute({});
    expect(first.workItems).toHaveLength(0);
    const receipts = await eventRows(KILL_EVENTS.receipt);
    expect(receipts).toHaveLength(1);
    expect((receipts[0].payloadJson as KillReceiptPayload).receipt).toBe(
      "Nothing to liquidate — all agents revoked",
    );

    const second = await execute({});
    expect(second.killId).not.toBe(first.killId); // completed kill never lingers active
  });

  it("stale revoke nonce → BAD_REQUEST before any state change", async () => {
    await seedPlans();
    const payload = { revokeAllAuth: { nonce: "3", signature: AUTH.signature } };
    await expect(execute(payload)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("re-prepare"),
    });
    expect(await eventRows(KILL_EVENTS.started)).toHaveLength(0);
  });

  it("missing auth with live plans → BAD_REQUEST, nothing written", async () => {
    await seedPlans();
    await expect(execute({})).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await eventRows(KILL_EVENTS.started)).toHaveLength(0);
  });

  it("a bad signature never reaches the relay", async () => {
    await seedPlans();
    const relay = killStubRelay({ verifyRevokeAll: () => false });
    setPlanRelayFactory(() => relay);
    await expect(execute()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(relay.calls).not.toContain("revokeAll");
  });

  it("scan failure aborts with nothing changed (honest retry)", async () => {
    await seedPlans();
    enumerateMock.mockRejectedValue(new Error("solana rpc down"));
    await expect(execute()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(await eventRows(KILL_EVENTS.started)).toHaveLength(0);
    const after = await db
      .select({ status: plans.status })
      .from(plans)
      .where(and(eq(plans.userId, userId), eq(plans.kind, "broker")));
    expect(after[0].status).toBe("active"); // untouched
  });
});

// ---------------------------------------------------------------------------
// kill.reportLeg
// ---------------------------------------------------------------------------

async function startKill() {
  const res = await execute({});
  return res;
}

describe("kill.reportLeg", () => {
  it("submitted claim stamps the id + AC1 mark; duplicate txId on another leg is refused", async () => {
    const { killId, workItems } = await startKill();
    const [a, b] = workItems;

    const r1 = await caller().kill.reportLeg({
      killId,
      legId: a.legId,
      phase: "submitted",
      transactionId: "killtx_a_123456",
    });
    expect(r1.outcome).toBe("submitted");
    const legA = (await legRows()).find((l) => l.legId === a.legId)!;
    expect(legA.transactionId).toBe("killtx_a_123456");
    expect(legA.submittedAtMs).toBeGreaterThan(0);

    // The same tx cannot be bound to a second leg (phantom-fill guard).
    await expect(
      caller().kill.reportLeg({
        killId,
        legId: b.legId,
        phase: "submitted",
        transactionId: "killtx_a_123456",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a malformed transaction id", async () => {
    const { killId, workItems } = await startKill();
    await expect(
      caller().kill.reportLeg({
        killId,
        legId: workItems[0].legId,
        phase: "submitted",
        transactionId: "bad id with spaces",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("terminal finished + owner + asset match → settled with the server's own numbers", async () => {
    const { killId, workItems } = await startKill();
    const spyxLeg = workItems.find((w) => w.assetId === "spyx")!;
    await caller().kill.reportLeg({
      killId,
      legId: spyxLeg.legId,
      phase: "submitted",
      transactionId: "killtx_spyx_0001",
    });

    pollMock.mockResolvedValue(polled("finished", finishedT(SPYX.address)));
    const res = await caller().kill.reportLeg({
      killId,
      legId: spyxLeg.legId,
      phase: "terminal",
      clientOutcome: "finished",
    });
    expect(res.outcome).toBe("settled");

    const leg = (await legRows()).find((l) => l.legId === spyxLeg.legId)!;
    expect(leg).toMatchObject({
      outcome: "settled",
      qty: 0.05,
      usd: 32.11,
      serverVerified: true,
      receipt: "Sold SPYx — now USDC in your balance.",
    });
  });

  it("terminal claim with a foreign-owner tx → failed, never a fill", async () => {
    const { killId, workItems } = await startKill();
    const leg = workItems[0];
    pollMock.mockResolvedValue(
      polled(
        "finished",
        finishedT(SPYX.address, {
          smartAccountOptions: { ownerAddress: "0x000000000000000000000000000000000000dEaD" },
        }),
      ),
    );
    const res = await caller().kill.reportLeg({
      killId,
      legId: leg.legId,
      phase: "terminal",
      transactionId: "killtx_foreign_01",
    });
    expect(res.outcome).toBe("failed");
    const row = (await legRows()).find((l) => l.legId === leg.legId)!;
    expect(row.error).toBe("did not match this account");
    expect(row.qty).toBeUndefined();
  });

  it("still-settling → CONFLICT, no state change", async () => {
    const { killId, workItems } = await startKill();
    pollMock.mockRejectedValue(new Error("504"));
    await expect(
      caller().kill.reportLeg({
        killId,
        legId: workItems[0].legId,
        phase: "terminal",
        transactionId: "killtx_slow_0001",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const row = (await legRows()).find((l) => l.legId === workItems[0].legId)!;
    expect(row.outcome).toBe("pending");
  });

  it("failed claim on a pending leg → failed + receipt; on a submitted leg → ignored", async () => {
    const { killId, workItems } = await startKill();
    const [a, b] = workItems;

    const r1 = await caller().kill.reportLeg({
      killId,
      legId: a.legId,
      phase: "failed",
      error: "quote expired",
    });
    expect(r1.outcome).toBe("failed");
    const legA = (await legRows()).find((l) => l.legId === a.legId)!;
    expect(legA.receipt).toBe(`Couldn't liquidate ${legA.symbol} — you can retry.`);

    await caller().kill.reportLeg({
      killId,
      legId: b.legId,
      phase: "submitted",
      transactionId: "killtx_b_1234567",
    });
    const r2 = await caller().kill.reportLeg({ killId, legId: b.legId, phase: "failed" });
    expect(r2.outcome).toBe("submitted"); // the tx may still land — never regressed
  });

  it("the last terminal report writes exactly ONE aggregate, even when raced", async () => {
    const { killId, workItems } = await startKill();
    // Fail the first leg; leave two in flight.
    await caller().kill.reportLeg({ killId, legId: workItems[0].legId, phase: "failed" });
    for (const [i, w] of [workItems[1], workItems[2]].entries()) {
      await caller().kill.reportLeg({
        killId,
        legId: w.legId,
        phase: "submitted",
        transactionId: `killtx_race_000${i}`,
      });
    }
    pollMock.mockImplementation(async () =>
      polled("finished", finishedT(TSLAX.address, {
        tokenChanges: {
          decr: [
            { token: { address: TSLAX.address }, amount: "0.1", amountInUSD: "32.00" },
            { token: { address: "0x0000000000000000000000000000000000000000" }, amount: "0.003", amountInUSD: "9.90" },
          ],
        },
      })),
    );

    // Concurrent terminal reports for the two remaining legs.
    await Promise.all([
      caller().kill.reportLeg({ killId, legId: workItems[1].legId, phase: "terminal" }),
      caller().kill.reportLeg({ killId, legId: workItems[2].legId, phase: "terminal" }),
    ]);

    const receipts = await eventRows(KILL_EVENTS.receipt);
    expect(receipts).toHaveLength(1);
    const payload = receipts[0].payloadJson as KillReceiptPayload;
    expect(payload).toMatchObject({ liquidated: 2, total: 3, retryable: 1, revoked: true });
    expect(payload.receipt).toBe(
      "Liquidated 2 of 3 positions to USDC · all agents revoked · 1 leg needs retry",
    );
    expect(payload.legs).toHaveLength(3);
  });

  it("duplicate terminal report converges without a second write", async () => {
    const { killId, workItems } = await startKill();
    const leg = workItems[0];
    pollMock.mockResolvedValue(polled("finished", finishedT(SPYX.address)));
    await caller().kill.reportLeg({
      killId,
      legId: leg.legId,
      phase: "terminal",
      transactionId: "killtx_dup_00001",
    });
    const again = await caller().kill.reportLeg({
      killId,
      legId: leg.legId,
      phase: "terminal",
      transactionId: "killtx_dup_00001",
    });
    expect(again.outcome).toBe("settled");
    expect((await legRows()).filter((l) => l.legId === leg.legId)).toHaveLength(1);
  });

  it("scopes strictly to the session user", async () => {
    const { killId, workItems } = await startKill();
    const [other] = await db
      .insert(users)
      .values({
        emailHash: `${EMAIL_HASH}-other`,
        eoaAddr: Wallet.createRandom().address,
        uaEvmAddr: "",
        uaSolAddr: "",
        region: "DE",
      })
      .returning({ id: users.id });
    const foreignCtx: Context = {
      db,
      session: { userId: other.id, eoaAddr: wallet.address, issuer: "did:x", region: "DE" },
      headers: new Headers(),
      resHeaders: new Headers(),
    };
    await expect(
      appRouter.createCaller(foreignCtx).kill.reportLeg({
        killId,
        legId: workItems[0].legId,
        phase: "failed",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// kill.retryLeg + kill.status
// ---------------------------------------------------------------------------

describe("kill.retryLeg", () => {
  it("failed → re-armed with attempt+1 and a clean payload", async () => {
    const { killId, workItems } = await startKill();
    const leg = workItems[0];
    await caller().kill.reportLeg({ killId, legId: leg.legId, phase: "failed" });

    const res = await retryLeg({ killId, legId: leg.legId });
    expect(res.attempt).toBe(2);
    expect(res.workItem.legId).toBe(leg.legId);
    const row = (await legRows()).find((l) => l.legId === leg.legId)!;
    expect(row.outcome).toBe("pending");
    expect(row.error).toBeUndefined();
    expect(row.receipt).toBeUndefined();
  });

  it("pending → the original work item, no state change (crash-before-send resume)", async () => {
    const { killId, workItems } = await startKill();
    const res = await retryLeg({ killId, legId: workItems[0].legId });
    expect(res.attempt).toBe(1);
    expect(res.workItem.amountHuman).toBe(workItems[0].amountHuman);
  });

  it("submitted + still in flight → CONFLICT (a live tx is never re-armed)", async () => {
    const { killId, workItems } = await startKill();
    await caller().kill.reportLeg({
      killId,
      legId: workItems[0].legId,
      phase: "submitted",
      transactionId: "killtx_flight_01",
    });
    pollMock.mockRejectedValue(new Error("504"));
    await expect(retryLeg({ killId, legId: workItems[0].legId })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "still settling",
    });
  });

  it("submitted but actually finished → truth applied, retry refused", async () => {
    const { killId, workItems } = await startKill();
    const spyxLeg = workItems.find((w) => w.assetId === "spyx")!;
    await caller().kill.reportLeg({
      killId,
      legId: spyxLeg.legId,
      phase: "submitted",
      transactionId: "killtx_landed_01",
    });
    pollMock.mockResolvedValue(polled("finished", finishedT(SPYX.address)));
    await expect(retryLeg({ killId, legId: spyxLeg.legId })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("already completed"),
    });
    const row = (await legRows()).find((l) => l.legId === spyxLeg.legId)!;
    expect(row.outcome).toBe("settled");
  });

  it("settled → CONFLICT; a post-aggregate retry success recomputes the aggregate in place", async () => {
    const { killId, workItems } = await startKill();
    // Drive all three legs terminal: two settled, one failed → aggregate.
    pollMock.mockResolvedValue(polled("finished", finishedT(SPYX.address, {
      tokenChanges: {
        decr: [
          { token: { address: SPYX.address }, amount: "0.05", amountInUSD: "32.11" },
          { token: { address: TSLAX.address }, amount: "0.1", amountInUSD: "32.00" },
          { token: { address: "0x0000000000000000000000000000000000000000" }, amount: "0.003", amountInUSD: "9.90" },
        ],
      },
    })));
    for (const [i, w] of workItems.slice(0, 2).entries()) {
      await caller().kill.reportLeg({
        killId,
        legId: w.legId,
        phase: "terminal",
        transactionId: `killtx_agg_0000${i}`,
      });
    }
    await caller().kill.reportLeg({ killId, legId: workItems[2].legId, phase: "failed" });

    let receipts = await eventRows(KILL_EVENTS.receipt);
    expect(receipts).toHaveLength(1);
    expect((receipts[0].payloadJson as KillReceiptPayload).retryable).toBe(1);

    // Settled legs are not retryable.
    await expect(retryLeg({ killId, legId: workItems[0].legId })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // Retry the failed leg → succeed → the SAME aggregate row updates.
    await retryLeg({ killId, legId: workItems[2].legId });
    await caller().kill.reportLeg({
      killId,
      legId: workItems[2].legId,
      phase: "terminal",
      transactionId: "killtx_agg_00002",
    });
    receipts = await eventRows(KILL_EVENTS.receipt);
    expect(receipts).toHaveLength(1);
    const updated = receipts[0].payloadJson as KillReceiptPayload;
    expect(updated).toMatchObject({ liquidated: 3, total: 3, retryable: 0 });
    expect(updated.receipt).toBe(
      "Liquidated 3 of 3 positions to USDC · all agents revoked",
    );
  });
});

describe("kill.status", () => {
  it("reconstructs truthfully from rows; revoked flips only on chain confirmation", async () => {
    await seedPlans();
    const relay = killStubRelay({ txStatus: async () => "pending" as const });
    setPlanRelayFactory(() => relay);
    const { killId, workItems } = await execute();

    let status = await caller().kill.status({ killId });
    expect(status.revoked).toBe(false); // submitted, not yet confirmed
    expect(status.revoke.state).toBe("submitted");
    expect(status.legs).toHaveLength(3);
    expect(status.done).toBe(false);

    // The chain confirms → revoked true, persisted.
    setPlanRelayFactory(() => killStubRelay());
    status = await caller().kill.status({ killId });
    expect(status.revoked).toBe(true);

    // AC1 marks surface once a leg submits.
    await caller().kill.reportLeg({
      killId,
      legId: workItems[0].legId,
      phase: "submitted",
      transactionId: "killtx_marks_001",
    });
    status = await caller().kill.status({ killId });
    expect(status.marks.lastSubmittedAtMs).toBeGreaterThan(0);
  });

  it("unknown killId → NOT_FOUND", async () => {
    await expect(
      caller().kill.status({ killId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
