import { createHmac } from "node:crypto";
import { estates, events, getDb, users } from "@retenix/db";
import { ESTATE_EVENTS } from "@retenix/shared";
import { and, eq, like } from "drizzle-orm";
import { Wallet } from "ethers";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createInternalServer, type HttpCtx } from "./http";
import {
  handleAddressActivity,
  networkFromSlug,
  verifyAlchemySignature,
} from "./webhooks";

/*
 * Alchemy Address Activity receiver: HMAC verification over the RAW body,
 * owner matching → notification event ONLY (the timer honesty invariant:
 * this module must never produce an estate.checkin), and the http.ts route
 * end-to-end (signature auth, not the bearer token).
 */

const db = getDb();
const PREFIX = "0xwebhook-test";
const OWNER = Wallet.createRandom().address;
const SIGNING_KEY = "whsec_test"; // workerTestEnv value

let userId: string;

function signed(body: string): string {
  return createHmac("sha256", SIGNING_KEY).update(Buffer.from(body)).digest("hex");
}

function activityBody(address: string): string {
  return JSON.stringify({
    webhookId: "wh_x",
    type: "ADDRESS_ACTIVITY",
    event: {
      network: "BASE_MAINNET",
      activity: [{ fromAddress: address, toAddress: `0x${"22".repeat(20)}` }],
    },
  });
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
  await db.insert(estates).values({
    userId,
    beneficiaryEmailEnc: "{}",
    contractStateCache: { status: "enrolled" },
  });
});

afterAll(cleanup);

describe("verifyAlchemySignature", () => {
  it("accepts the HMAC of the exact raw bytes, rejects everything else", () => {
    const body = Buffer.from(activityBody(OWNER));
    expect(verifyAlchemySignature(body, signed(body.toString()))).toBe(true);
    expect(verifyAlchemySignature(body, signed(body.toString()) + "00")).toBe(false);
    expect(verifyAlchemySignature(body, signed("other body"))).toBe(false);
    expect(verifyAlchemySignature(body, undefined)).toBe(false);
  });
});

describe("networkFromSlug", () => {
  it("maps Alchemy slugs to display names, canon-safe fallback", () => {
    expect(networkFromSlug("BASE_MAINNET")).toBe("Base");
    expect(networkFromSlug("ARB_MAINNET")).toBe("Arbitrum");
    expect(networkFromSlug("SOMETHING_ELSE")).toBe("one of your sources");
    expect(networkFromSlug(undefined)).toBe("one of your sources");
  });
});

describe("handleAddressActivity", () => {
  it("matched owner → notification event + immediate observation; NEVER a check-in", async () => {
    const observe = vi.fn(async () => ({}));
    const res = await handleAddressActivity(
      { db, observe },
      JSON.parse(activityBody(OWNER)),
    );
    expect(res.matched).toBe(1);
    // fire-and-forget observe was kicked
    await new Promise((r) => setTimeout(r, 10));
    expect(observe).toHaveBeenCalledOnce();

    const noticed = await db
      .select({ payload: events.payloadJson })
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.type, ESTATE_EVENTS.activityNoticed)));
    expect(noticed).toHaveLength(1);
    expect((noticed[0]!.payload as { receipt: string }).receipt).toBe(
      "We noticed activity on Base — confirming your check-in now.",
    );

    // the timer honesty invariant: the webhook wrote NO estate.checkin
    const checkins = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.type, ESTATE_EVENTS.checkin)));
    expect(checkins).toHaveLength(0);
  });

  it("unmatched addresses do nothing", async () => {
    const res = await handleAddressActivity(
      { db },
      JSON.parse(activityBody(`0x${"33".repeat(20)}`)),
    );
    expect(res.matched).toBe(0);
  });
});

describe("POST /webhooks/alchemy (route)", () => {
  function ctx(): HttpCtx {
    return {
      db,
      boss: { send: vi.fn(async () => null) },
      demoMode: true,
      estateWebhook: { db },
    } as never;
  }

  async function post(body: string, signature?: string) {
    const server = createInternalServer(ctx());
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as { port: number };
    try {
      return await fetch(`http://127.0.0.1:${port}/webhooks/alchemy`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(signature ? { "x-alchemy-signature": signature } : {}),
        },
        body,
      });
    } finally {
      server.close();
    }
  }

  it("accepts a correctly signed payload (no bearer token involved)", async () => {
    const body = activityBody(OWNER);
    const res = await post(body, signed(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ matched: 1 });
  });

  it("rejects a bad/absent signature", async () => {
    const body = activityBody(OWNER);
    expect((await post(body, signed("tampered"))).status).toBe(401);
    expect((await post(body)).status).toBe(401);
  });
});
