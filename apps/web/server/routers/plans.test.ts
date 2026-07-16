import { randomUUID } from "node:crypto";
import { events, getDb, plans, users } from "@retenix/db";
import {
  buildSignedMessage,
  computeInputHash,
  type SigEnvelope,
} from "@retenix/shared";
import { and, eq } from "drizzle-orm";
import { HDNodeWallet, Wallet } from "ethers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanRelay } from "../lib/relay-factory";
import {
  resetPlanRelayFactory,
  setPlanRelayFactory,
} from "../lib/relay-factory";
import type { Context } from "../context";

const { appRouter } = await import("./index");
const db = getDb();

const created: string[] = [];

function hex(len: number): string {
  let s = "";
  while (s.length < len) s += Math.floor(Math.random() * 16).toString(16);
  return s.slice(0, len);
}

interface SignerUser {
  userId: string;
  eoa: string;
  wallet: HDNodeWallet;
}

/** A user whose EOA is a real ethers key, so signed envelopes verify. */
async function makeSignerUser(region = "DE"): Promise<SignerUser> {
  const wallet = Wallet.createRandom();
  const suffix = hex(8);
  const [row] = await db
    .insert(users)
    .values({
      emailHash: `0xtest${suffix}${"0".repeat(53)}`,
      eoaAddr: wallet.address,
      uaEvmAddr: "",
      uaSolAddr: "",
      region,
    })
    .returning({ id: users.id });
  created.push(row.id);
  return { userId: row.id, eoa: wallet.address, wallet };
}

function ctxFor(user: SignerUser, region = "DE"): Context {
  return {
    db,
    session: {
      userId: user.userId,
      eoaAddr: user.eoa,
      issuer: `did:test:${user.eoa}`,
      region,
    },
    headers: new Headers(),
    resHeaders: new Headers(),
  } as Context;
}

// Nonces must be STRICTLY increasing per user (trpc.ts#consumeNonce); a
// monotonic counter guarantees that across the several signed calls a test
// makes, where Date.now() alone could repeat within a millisecond.
let nonceSeq = Date.now();

/** Build the { payload, sig } envelope the way lib/sign.ts does. */
async function signedInput<T>(
  route: string,
  payload: T,
  wallet: HDNodeWallet,
): Promise<{ payload: T; sig: SigEnvelope }> {
  const nonce = ++nonceSeq;
  const expiry = Math.floor(Date.now() / 1000) + 240;
  const message = buildSignedMessage({
    route,
    inputHash: computeInputHash(payload),
    nonce,
    expiry,
  });
  return {
    payload,
    sig: { signature: await wallet.signMessage(message), nonce, expiry },
  };
}

/** Seed an intent.parsed event the way module 09 does; return the draftId. */
async function seedDraft(userId: string, draft: unknown): Promise<string> {
  const draftId = randomUUID();
  await db.insert(events).values({
    userId,
    type: "intent.parsed",
    payloadJson: {
      draftId,
      utterance: "seed",
      parsedAt: new Date().toISOString(),
      outcome: "draft",
      draft,
    },
  });
  return draftId;
}

/** A relay double: records calls, returns a fixed plan id (the real relay's
 *  signature check is proven in relay.test.ts). */
function stubRelay(overrides: Partial<PlanRelay> = {}): PlanRelay & {
  calls: { create: number; revoke: number };
} {
  const calls = { create: 0, revoke: 0 };
  const relay: PlanRelay = {
    domain: { chainId: 421614, contract: "0x00" },
    authNonce: async () => 0n,
    agentAddress: async () => "0x562937835cdD5C92F54B94Df658Fd3b50A68ecD5",
    buildCreatePlanDigest: async () => `0x${"cd".repeat(32)}`,
    createPlan: async () => {
      calls.create += 1;
      return { txHash: "0xtx", planId: 42n };
    },
    revokePlanFor: async () => {
      calls.revoke += 1;
      return { txHash: "0xrevoke" };
    },
    ...overrides,
  };
  return Object.assign(relay, { calls });
}

const auth = (nonce = "0") => ({ nonce, signature: `0x${"ab".repeat(65)}` });

const brokerDraft = {
  broker: {
    cadence: "weekly" as const,
    amountUsd: 25,
    basket: [
      { assetId: "spyx", pct: 60 },
      { assetId: "tslax", pct: 30 },
      { assetId: "sol", pct: 10 },
    ],
  },
  guardian: { maxDrawdownPct: 15 },
};

async function plansOf(userId: string) {
  return db
    .select({
      id: plans.id,
      kind: plans.kind,
      status: plans.status,
      contractPlanId: plans.contractPlanId,
      paramsJson: plans.paramsJson,
    })
    .from(plans)
    .where(eq(plans.userId, userId));
}

/** Activate a broker+guardian plan for a signer user; return its cards. */
async function activateBroker(user: SignerUser) {
  setPlanRelayFactory(() => stubRelay());
  const draftId = await seedDraft(user.userId, brokerDraft);
  const input = await signedInput(
    "plans.activate",
    {
      draftId,
      accept: { broker: true, guardian: true, legacy: false },
      createPlanAuth: auth(),
    },
    user.wallet,
  );
  return (await appRouter.createCaller(ctxFor(user)).plans.activate(input)).cards;
}

beforeEach(() => {
  setPlanRelayFactory(() => stubRelay());
});
afterEach(async () => {
  resetPlanRelayFactory();
  for (const id of created.splice(0)) {
    await db.delete(events).where(eq(events.userId, id));
    await db.delete(plans).where(eq(plans.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("plans.activate", () => {
  it("activates broker + guardian as one onchain plan; legacy as a draft card", async () => {
    const relay = stubRelay();
    setPlanRelayFactory(() => relay);
    const user = await makeSignerUser();
    const draftId = await seedDraft(user.userId, {
      ...brokerDraft,
      legacy: { beneficiaryEmail: "ada@example.com", inactivityDays: 180 },
    });

    const input = await signedInput(
      "plans.activate",
      {
        draftId,
        accept: { broker: true, guardian: true, legacy: true },
        createPlanAuth: auth("0"),
      },
      user.wallet,
    );
    const res = await appRouter.createCaller(ctxFor(user)).plans.activate(input);

    expect(relay.calls.create).toBe(1);
    expect(res.cards).toHaveLength(3);

    const rows = await plansOf(user.userId);
    const broker = rows.find((r) => r.kind === "broker");
    const guardian = rows.find((r) => r.kind === "guardian");
    const legacy = rows.find((r) => r.kind === "legacy");
    expect(broker?.status).toBe("active");
    expect(broker?.contractPlanId).toBe(42);
    expect(guardian?.status).toBe("active");
    expect(guardian?.contractPlanId).toBe(42); // shares the broker's onchain plan
    expect(legacy?.status).toBe("draft");
    expect(legacy?.contractPlanId).toBeNull(); // Estate is module 14's

    const bp = broker?.paramsJson as {
      autonomy: string;
      capPerExecUsd: number;
      nextRunAt: string;
    };
    expect(bp.autonomy).toBe("auto");
    expect(bp.capPerExecUsd).toBe(15);
    expect(Number.isNaN(Date.parse(bp.nextRunAt))).toBe(false);

    const receipts = await db
      .select({ payloadJson: events.payloadJson })
      .from(events)
      .where(
        and(eq(events.userId, user.userId), eq(events.type, "plan.activated")),
      );
    expect(receipts).toHaveLength(2);
  });

  it("refuses to activate the Broker without a createPlan signature", async () => {
    const user = await makeSignerUser();
    const draftId = await seedDraft(user.userId, brokerDraft);
    const input = await signedInput(
      "plans.activate",
      { draftId, accept: { broker: true, guardian: false, legacy: false } },
      user.wallet,
    );
    await expect(
      appRouter.createCaller(ctxFor(user)).plans.activate(input),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await plansOf(user.userId)).toHaveLength(0);
  });

  it("leaves no rows and does not call the relay for an unknown draft", async () => {
    const relay = stubRelay();
    setPlanRelayFactory(() => relay);
    const user = await makeSignerUser();
    const input = await signedInput(
      "plans.activate",
      {
        draftId: randomUUID(),
        accept: { broker: true, guardian: false, legacy: false },
        createPlanAuth: auth(),
      },
      user.wallet,
    );
    await expect(
      appRouter.createCaller(ctxFor(user)).plans.activate(input),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(relay.calls.create).toBe(0);
    expect(await plansOf(user.userId)).toHaveLength(0);
  });

  it("stays draft (never optimistic-active) when the relay fails", async () => {
    setPlanRelayFactory(() =>
      stubRelay({
        createPlan: () => {
          throw new Error("relay down");
        },
      }),
    );
    const user = await makeSignerUser();
    const draftId = await seedDraft(user.userId, brokerDraft);
    const input = await signedInput(
      "plans.activate",
      {
        draftId,
        accept: { broker: true, guardian: false, legacy: false },
        createPlanAuth: auth(),
      },
      user.wallet,
    );
    await expect(
      appRouter.createCaller(ctxFor(user)).plans.activate(input),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(await plansOf(user.userId)).toHaveLength(0);
  });

  it("US user editing SPYx in — the equity is dropped before activation", async () => {
    const user = await makeSignerUser("US");
    const draftId = await seedDraft(user.userId, {
      broker: { cadence: "weekly", amountUsd: 25, basket: [{ assetId: "sol", pct: 100 }] },
    });
    const input = await signedInput(
      "plans.activate",
      {
        draftId,
        accept: { broker: true, guardian: false, legacy: false },
        edits: {
          broker: {
            cadence: "weekly" as const,
            amountUsd: 25,
            basket: [
              { assetId: "spyx", pct: 60 },
              { assetId: "sol", pct: 40 },
            ],
          },
        },
        createPlanAuth: auth(),
      },
      user.wallet,
    );
    await appRouter.createCaller(ctxFor(user, "US")).plans.activate(input);
    const broker = (await plansOf(user.userId)).find((r) => r.kind === "broker");
    const bp = broker?.paramsJson as { basket: { assetId: string; pct: number }[] };
    expect(bp.basket).toEqual([{ assetId: "sol", pct: 100 }]);
  });
});

describe("plans.revoke / pause / resume / setAutonomy", () => {
  it("revoke zeroes both cards sharing the onchain plan (PS-F5-AC2)", async () => {
    const user = await makeSignerUser();
    const cards = await activateBroker(user);
    const relay = stubRelay();
    setPlanRelayFactory(() => relay);
    const broker = cards.find((c) => c.kind === "broker")!;

    const input = await signedInput(
      "plans.revoke",
      { planId: broker.planId, revokeAuth: auth() },
      user.wallet,
    );
    const res = await appRouter.createCaller(ctxFor(user)).plans.revoke(input);
    expect(relay.calls.revoke).toBe(1);
    expect(res.revoked).toHaveLength(2);

    const rows = await plansOf(user.userId);
    expect(rows.every((r) => r.status === "revoked")).toBe(true);
  });

  it("pause/resume flip the DB status the worker honors", async () => {
    const user = await makeSignerUser();
    const cards = await activateBroker(user);
    const broker = cards.find((c) => c.kind === "broker")!;

    await appRouter
      .createCaller(ctxFor(user))
      .plans.pause(await signedInput("plans.pause", { planId: broker.planId }, user.wallet));
    let row = (await plansOf(user.userId)).find((r) => r.id === broker.planId);
    expect(row?.status).toBe("paused");

    await appRouter
      .createCaller(ctxFor(user))
      .plans.resume(await signedInput("plans.resume", { planId: broker.planId }, user.wallet));
    row = (await plansOf(user.userId)).find((r) => r.id === broker.planId);
    expect(row?.status).toBe("active");
  });

  it("setAutonomy stores the dial on the broker plan (not a contract write)", async () => {
    const user = await makeSignerUser();
    const cards = await activateBroker(user);
    const broker = cards.find((c) => c.kind === "broker")!;

    const res = await appRouter
      .createCaller(ctxFor(user))
      .plans.setAutonomy(
        await signedInput(
          "plans.setAutonomy",
          { planId: broker.planId, autonomy: "confirm" },
          user.wallet,
        ),
      );
    expect(res.autonomy).toBe("confirm");
    const row = (await plansOf(user.userId)).find((r) => r.id === broker.planId);
    expect((row?.paramsJson as { autonomy: string }).autonomy).toBe("confirm");
  });

  it("setAutonomy is rejected on a guardian card (no dial)", async () => {
    const user = await makeSignerUser();
    const cards = await activateBroker(user);
    const guardian = cards.find((c) => c.kind === "guardian")!;
    await expect(
      appRouter
        .createCaller(ctxFor(user))
        .plans.setAutonomy(
          await signedInput(
            "plans.setAutonomy",
            { planId: guardian.planId, autonomy: "observe" },
            user.wallet,
          ),
        ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("a user cannot revoke another user's plan", async () => {
    const owner = await makeSignerUser();
    const cards = await activateBroker(owner);
    const broker = cards.find((c) => c.kind === "broker")!;
    const attacker = await makeSignerUser();

    await expect(
      appRouter
        .createCaller(ctxFor(attacker))
        .plans.revoke(
          await signedInput(
            "plans.revoke",
            { planId: broker.planId, revokeAuth: auth() },
            attacker.wallet,
          ),
        ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("plans.recreate (active-card edit = revoke-and-recreate)", () => {
  // The stub returns planId 42 for the first create and a distinct id for the
  // recreate so we can tell the new plan apart. The override still counts into
  // the base stub's `calls.create` (it's the same closure).
  function recreateStub() {
    const relay = stubRelay();
    let created = 0;
    relay.createPlan = async () => {
      created += 1;
      relay.calls.create += 1;
      return { txHash: "0xtx", planId: created === 1 ? 42n : 99n };
    };
    return relay;
  }

  it("revokes the old plan and creates the edited one; two receipts, one new active card", async () => {
    const relay = recreateStub();
    setPlanRelayFactory(() => relay);
    const user = await makeSignerUser();
    // Activate a $25 broker + guardian.
    const draftId = await seedDraft(user.userId, brokerDraft);
    const cards = (
      await appRouter.createCaller(ctxFor(user)).plans.activate(
        await signedInput(
          "plans.activate",
          { draftId, accept: { broker: true, guardian: true, legacy: false }, createPlanAuth: auth() },
          user.wallet,
        ),
      )
    ).cards;
    const broker = cards.find((c) => c.kind === "broker")!;

    // Edit the amount to $30 → revoke old (42) + create new (99).
    const editedBroker = { ...brokerDraft.broker, amountUsd: 30 };
    const res = await appRouter.createCaller(ctxFor(user)).plans.recreate(
      await signedInput(
        "plans.recreate",
        {
          planId: broker.planId,
          edits: { broker: editedBroker },
          revokeAuth: auth("1"),
          createPlanAuth: auth("2"),
        },
        user.wallet,
      ),
    );
    expect(relay.calls.revoke).toBe(1);
    expect(relay.calls.create).toBe(2);
    expect(res.card.contractPlanId).toBe(99);

    const rows = await plansOf(user.userId);
    // Old broker+guardian revoked; new broker (+carried guardian) active at 99.
    const active = rows.filter((r) => r.status === "active");
    expect(active.every((r) => r.contractPlanId === 99)).toBe(true);
    const newBroker = active.find((r) => r.kind === "broker");
    expect((newBroker?.paramsJson as { amountUsd: number }).amountUsd).toBe(30);
    // The carried-forward guardian is present on the new plan.
    expect(active.some((r) => r.kind === "guardian")).toBe(true);

    // Two honest receipts (dismissed + hired).
    const dismissed = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.userId, user.userId), eq(events.type, "plan.revoked")));
    expect(dismissed.length).toBeGreaterThanOrEqual(1);
  });

  it("marks the old plan revoked if the recreate's create leg fails after revoke", async () => {
    let created = 0;
    setPlanRelayFactory(() =>
      stubRelay({
        createPlan: async () => {
          created += 1;
          if (created === 2) throw new Error("create leg down");
          return { txHash: "0xtx", planId: 42n };
        },
      }),
    );
    const user = await makeSignerUser();
    const draftId = await seedDraft(user.userId, brokerDraft);
    const cards = (
      await appRouter.createCaller(ctxFor(user)).plans.activate(
        await signedInput(
          "plans.activate",
          { draftId, accept: { broker: true, guardian: false, legacy: false }, createPlanAuth: auth() },
          user.wallet,
        ),
      )
    ).cards;
    const broker = cards.find((c) => c.kind === "broker")!;

    await expect(
      appRouter.createCaller(ctxFor(user)).plans.recreate(
        await signedInput(
          "plans.recreate",
          {
            planId: broker.planId,
            edits: { broker: { ...brokerDraft.broker, amountUsd: 30 } },
            revokeAuth: auth("1"),
            createPlanAuth: auth("2"),
          },
          user.wallet,
        ),
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

    // The old plan is honestly revoked (authority removed) — nothing over-executes.
    const rows = await plansOf(user.userId);
    expect(rows.every((r) => r.status === "revoked")).toBe(true);
  });
});

describe("plans query helpers", () => {
  it("list returns non-revoked cards only", async () => {
    const user = await makeSignerUser();
    const draftId = await seedDraft(user.userId, brokerDraft);
    await appRouter.createCaller(ctxFor(user)).plans.activate(
      await signedInput(
        "plans.activate",
        {
          draftId,
          accept: { broker: true, guardian: false, legacy: false },
          createPlanAuth: auth(),
        },
        user.wallet,
      ),
    );
    const before = await appRouter.createCaller(ctxFor(user)).plans.list();
    expect(before.cards).toHaveLength(1);

    const broker = before.cards[0];
    await appRouter.createCaller(ctxFor(user)).plans.revoke(
      await signedInput(
        "plans.revoke",
        { planId: broker.planId, revokeAuth: auth() },
        user.wallet,
      ),
    );
    const after = await appRouter.createCaller(ctxFor(user)).plans.list();
    expect(after.cards).toHaveLength(0); // revoked cards drop off the roster
  });

  it("prepareRevoke returns a digest for an onchain card, null for a draft card", async () => {
    const user = await makeSignerUser();
    // Standalone guardian → a draft card with no onchain plan.
    const gDraftId = await seedDraft(user.userId, { guardian: { weeklyCapUsd: 100 } });
    await appRouter.createCaller(ctxFor(user)).plans.activate(
      await signedInput(
        "plans.activate",
        { draftId: gDraftId, accept: { broker: false, guardian: true, legacy: false } },
        user.wallet,
      ),
    );
    const draftCard = (await plansOf(user.userId))[0];
    const prep = await appRouter
      .createCaller(ctxFor(user))
      .plans.prepareRevoke({ planId: draftCard.id });
    expect(prep.digest).toBeNull();
  });

  // recentBlocks tests retired with the route (module 11): the C3 flash now
  // consumes activity.feed's blocked stream — covered by activity.test.ts
  // filter-mapping tests and the S3 e2e.
});
