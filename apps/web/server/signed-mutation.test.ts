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
 * send.execute (real since module 15, gatedSigned) stays the probe: a
 * report-phase payload with an unknown executionId reaches the body with NO
 * network I/O and deterministically answers BAD_REQUEST "unknown or
 * unauthorized execution" — reaching the body proves the signature middleware
 * *passed*; any UNAUTHORIZED means it rejected. (This test moved off
 * plans.activate when module 10 gave it a real payload.)
 */
const ROUTE = "send.execute";
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

/** Schema-valid report payload whose executionId can never exist — the body
 *  answers BAD_REQUEST without touching any network edge. `tag` must be hex
 *  (it lands inside the uuid). */
const probePayload = (tag: string) => ({
  phase: "report" as const,
  // uuid v4 shape, deterministic per tag
  executionId: `00000000-0000-4000-8000-${tag.padEnd(12, "0").slice(0, 12)}`,
  clientOutcome: "failed" as const,
});

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
    const payload = probePayload("abc");
    const sig = await sign(payload, { nonce: Date.now(), expiry: inFiveMinutes() });

    // Reaching the body proves the signature verified against session.eoaAddr.
    await expect(
      appRouter.createCaller(ctx()).send.execute({ payload, sig }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: /unknown or unauthorized execution/,
    });
  });

  it("rejects a replayed nonce", async () => {
    const payload = probePayload("ae91a1");
    const nonce = Date.now() + 1_000;
    const sig = await sign(payload, { nonce, expiry: inFiveMinutes() });

    await expect(
      appRouter.createCaller(ctx()).send.execute({ payload, sig }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Byte-identical envelope, second time.
    await expect(
      appRouter.createCaller(ctx()).send.execute({ payload, sig }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: /nonce reused/ });
  });

  it("rejects a signature from a key that is not the session EOA", async () => {
    const impostor = Wallet.createRandom();
    const payload = probePayload("1b9057");
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
      appRouter.createCaller(ctx()).send.execute({ payload, sig }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: /signer is not the session EOA/,
    });
  });

  it("rejects a signature over a different payload", async () => {
    const nonce = Date.now() + 3_000;
    const sig = await sign(probePayload("516ed0"), { nonce, expiry: inFiveMinutes() });

    await expect(
      appRouter
        .createCaller(ctx())
        .send.execute({ payload: probePayload("5e47a7"), sig }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects an expired signature", async () => {
    const payload = probePayload("57a1e0");
    const nonce = Date.now() + 4_000;
    const sig = await sign(payload, {
      nonce,
      expiry: Math.floor(Date.now() / 1000) - 1,
    });

    await expect(
      appRouter.createCaller(ctx()).send.execute({ payload, sig }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: /expired/ });
  });

  it("rejects an expiry beyond the five-minute replay window", async () => {
    const payload = probePayload("70fa20");
    const nonce = Date.now() + 5_000;
    const sig = await sign(payload, {
      nonce,
      expiry: Math.floor(Date.now() / 1000) + 301,
    });

    await expect(
      appRouter.createCaller(ctx()).send.execute({ payload, sig }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: /5-minute/ });
  });

  it("is UNAUTHORIZED without a session, before any signature is examined", async () => {
    const payload = probePayload("905e55");
    const sig = await sign(payload, { nonce: Date.now() + 6_000, expiry: inFiveMinutes() });
    const anonymous: Context = { ...ctx(), session: null };

    await expect(
      appRouter.createCaller(anonymous).send.execute({ payload, sig }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: /sign in required/ });
  });
});
