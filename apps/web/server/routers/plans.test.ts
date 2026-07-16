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
