import { getDb, users } from "@retenix/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "../context";
import { appRouter } from "./index";

const db = getDb();

// Distinct fixtures so this file never collides with auth.test's rows in the same DB.
const EMAIL_HASH = "0xacct-bootstrap-test-emailhash";
const EOA = "0xaBcDeF0123456789aBcDeF0123456789aBcDeF01"; // mixed-case, 40 hex
const EOA_LOWER = EOA.toLowerCase();
const UA_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // valid base58 (USDC mint)

async function insertUser(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      emailHash: EMAIL_HASH,
      eoaAddr: EOA,
      uaEvmAddr: "", // doc 02 writes "" until doc 03 bootstraps
      uaSolAddr: "",
      region: "",
    })
    .returning({ id: users.id });
  return row.id;
}

function ctxFor(userId: string): Context {
  return {
    db,
    session: { userId, eoaAddr: EOA, issuer: "did:test", region: "" },
    headers: new Headers(),
    resHeaders: new Headers(),
  };
}

async function cleanup() {
  await db.delete(users).where(eq(users.emailHash, EMAIL_HASH));
}

beforeEach(cleanup);
afterAll(cleanup);

describe("account.bootstrap (doc 03 task 7 — first-login address persistence)", () => {
  it("persists ua_evm_addr = the session EOA and ua_sol_addr on first login", async () => {
    const id = await insertUser();
    // Client sends the lowercase-derived uaEvm; server persists the canonical session EOA.
    const res = await appRouter
      .createCaller(ctxFor(id))
      .account.bootstrap({ uaEvm: EOA_LOWER, uaSol: UA_SOL });
    expect(res).toEqual({ bootstrapped: true, uaEvm: EOA, uaSol: UA_SOL });

    const [row] = await db.select().from(users).where(eq(users.id, id));
    expect(row.uaEvmAddr).toBe(EOA); // canonical casing from the session, not the client
    expect(row.uaSolAddr).toBe(UA_SOL);
  });

  it("is idempotent — a second call reports bootstrapped:false and does not overwrite", async () => {
    const id = await insertUser();
    const caller = appRouter.createCaller(ctxFor(id));
    await caller.account.bootstrap({ uaEvm: EOA_LOWER, uaSol: UA_SOL });
    const second = await caller.account.bootstrap({
      uaEvm: EOA_LOWER,
      uaSol: "So11111111111111111111111111111111111111112", // different — must be ignored
    });
    expect(second.bootstrapped).toBe(false);
    expect(second.uaSol).toBe(UA_SOL);

    const [row] = await db.select().from(users).where(eq(users.id, id));
    expect(row.uaSolAddr).toBe(UA_SOL); // unchanged
  });

  it("rejects when uaEvm != the session EOA (7702 invariant)", async () => {
    const id = await insertUser();
    await expect(
      appRouter.createCaller(ctxFor(id)).account.bootstrap({
        uaEvm: "0xdead000000000000000000000000000000000000",
        uaSol: UA_SOL,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects an invalid Solana address", async () => {
    const id = await insertUser();
    await expect(
      appRouter
        .createCaller(ctxFor(id))
        .account.bootstrap({ uaEvm: EOA_LOWER, uaSol: "0xnot-a-solana-address" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("requires a session (UNAUTHORIZED without one)", async () => {
    await expect(
      appRouter
        .createCaller({
          db,
          session: null,
          headers: new Headers(),
          resHeaders: new Headers(),
        })
        .account.bootstrap({ uaEvm: EOA_LOWER, uaSol: UA_SOL }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
