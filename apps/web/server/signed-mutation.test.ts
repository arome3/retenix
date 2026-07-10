import { events, getDb, users } from "@retenix/db";
import {
  buildSignedMessage,
  computeInputHash,
  type SigEnvelope,
} from "@retenix/shared";
import { eq } from "drizzle-orm";
import { Wallet } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashEmail } from "@/lib/emailHash";
import type { Context } from "./context";
import { appRouter } from "./routers";

/*
 * The signed-mutation round trip (doc 00 / doc 02). The client half is
 * lib/sign.ts, which asks Magic for a personal_sign; here an ethers Wallet
 * stands in for Magic, because the server only ever recovers a signer from a
 * message — it cannot tell, and must not care, which key custodian produced it.
 *
 * plans.activate is a real signedProcedure whose body throws NOT_IMPLEMENTED
 * (module 10 owns it). That makes it the perfect probe: NOT_IMPLEMENTED means
 * the signature middleware *passed*, and any UNAUTHORIZED means it rejected.
 */
const ROUTE = "plans.activate";
const EMAIL = "signer@example.com";
const db = getDb();
const wallet = Wallet.createRandom();

let userId: string;

const ctx = (): Context => ({
  db,
  session: {
    userId,
    eoaAddr: wallet.address,
    issuer: `did:ethr:${wallet.address}`,
    region: "US",
  },
  headers: new Headers(),
  resHeaders: new Headers(),
});

async function sign(
  payload: unknown,
  { nonce, expiry }: { nonce: number; expiry: number },
): Promise<SigEnvelope> {
  const message = buildSignedMessage({
    route: ROUTE,
    inputHash: computeInputHash(payload),
    nonce,
    expiry,
  });
  return { signature: await wallet.signMessage(message), nonce, expiry };
}

const inFiveMinutes = () => Math.floor(Date.now() / 1000) + 240;

async function cleanup() {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.emailHash, hashEmail(EMAIL)));
  for (const row of rows) {
    await db.delete(events).where(eq(events.userId, row.id));
    await db.delete(users).where(eq(users.id, row.id));
  }
}

beforeAll(async () => {
  await cleanup();
  const [row] = await db
    .insert(users)
    .values({
      emailHash: hashEmail(EMAIL),
      eoaAddr: wallet.address,
      uaEvmAddr: "",
      uaSolAddr: "",
      region: "US",
    })
    .returning({ id: users.id });
  userId = row.id;
});
afterAll(cleanup);

describe("signedProcedure round trip", () => {
  it("recovers the session EOA from a fresh personal_sign", async () => {
    const payload = { planId: "abc", amountUsd: 25 };
    const sig = await sign(payload, { nonce: Date.now(), expiry: inFiveMinutes() });

    // Reaching the body proves the signature verified against session.eoaAddr.
    await expect(
      appRouter.createCaller(ctx()).plans.activate({ payload, sig }),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("rejects a replayed nonce", async () => {
    const payload = { planId: "replay" };
    const nonce = Date.now() + 1_000;
    const sig = await sign(payload, { nonce, expiry: inFiveMinutes() });

    await expect(
      appRouter.createCaller(ctx()).plans.activate({ payload, sig }),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });

    // Byte-identical envelope, second time.
    await expect(
      appRouter.createCaller(ctx()).plans.activate({ payload, sig }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: /nonce reused/ });
  });

  it("rejects a signature from a key that is not the session EOA", async () => {
    const impostor = Wallet.createRandom();
    const payload = { planId: "impostor" };
    const nonce = Date.now() + 2_000;
    const expiry = inFiveMinutes();
    const message = buildSignedMessage({
      route: ROUTE,
      inputHash: computeInputHash(payload),
      nonce,
      expiry,
    });
    const sig: SigEnvelope = {
      signature: await impostor.signMessage(message),
      nonce,
      expiry,
    };

    await expect(
      appRouter.createCaller(ctx()).plans.activate({ payload, sig }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: /signer is not the session EOA/,
    });
  });

  it("rejects a signature over a different payload", async () => {
    const nonce = Date.now() + 3_000;
    const sig = await sign({ planId: "signed-this" }, { nonce, expiry: inFiveMinutes() });

    await expect(
      appRouter
        .createCaller(ctx())
        .plans.activate({ payload: { planId: "sent-that" }, sig }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects an expired signature", async () => {
    const payload = { planId: "stale" };
    const nonce = Date.now() + 4_000;
    const sig = await sign(payload, {
      nonce,
      expiry: Math.floor(Date.now() / 1000) - 1,
    });

    await expect(
      appRouter.createCaller(ctx()).plans.activate({ payload, sig }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: /expired/ });
  });

  it("rejects an expiry beyond the five-minute replay window", async () => {
    const payload = { planId: "too-far" };
    const nonce = Date.now() + 5_000;
    const sig = await sign(payload, {
      nonce,
      expiry: Math.floor(Date.now() / 1000) + 301,
    });

    await expect(
      appRouter.createCaller(ctx()).plans.activate({ payload, sig }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: /5-minute/ });
  });

  it("is UNAUTHORIZED without a session, before any signature is examined", async () => {
    const payload = { planId: "no-session" };
    const sig = await sign(payload, { nonce: Date.now() + 6_000, expiry: inFiveMinutes() });
    const anonymous: Context = { ...ctx(), session: null };

    await expect(
      appRouter.createCaller(anonymous).plans.activate({ payload, sig }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: /sign in required/ });
  });
});
