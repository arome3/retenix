import { getDb, users } from "@retenix/db";
import { getPrimaryAssets, type IAssetsResponse } from "@retenix/ua";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { summaryCache } from "../lib/summary";
import type { Context } from "../context";
import { appRouter } from "./index";

// account.summary reads Particle through @retenix/ua; unit tests must never
// reach the network. Partial mock: everything else stays real.
vi.mock("@retenix/ua", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@retenix/ua")>();
  return {
    ...actual,
    createUa: vi.fn(() => ({}) as never),
    getPrimaryAssets: vi.fn(),
  };
});
const getPrimaryAssetsMock = vi.mocked(getPrimaryAssets);

const db = getDb();

// Distinct fixtures so this file never collides with auth.test's rows in the same DB.
const EMAIL_HASH = "0xacct-bootstrap-test-emailhash";
const EOA = "0xaBcDeF0123456789aBcDeF0123456789aBcDeF01"; // mixed-case, 40 hex
const EOA_LOWER = EOA.toLowerCase();
const UA_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // valid base58 (USDC mint)

async function insertUser(region = ""): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      emailHash: EMAIL_HASH,
      eoaAddr: EOA,
      uaEvmAddr: "", // doc 02 writes "" until doc 03 bootstraps
      uaSolAddr: "",
      region,
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

beforeEach(async () => {
  await cleanup();
  summaryCache.clear();
  getPrimaryAssetsMock.mockReset();
});
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

// Minimal well-formed IAssetsResponse: $6 USDC on Base, $4 ETH on Ethereum.
const ASSETS_FIXTURE = {
  totalAmountInUSD: 10,
  assets: [
    {
      tokenType: "usdc",
      price: 1,
      amount: 6,
      amountInUSD: 6,
      chainAggregation: [
        { token: { chainId: 8453, address: "0x0", decimals: 18, realDecimals: 6 }, amount: 6, amountInUSD: 6, rawAmount: 0 },
      ],
    },
    {
      tokenType: "eth",
      price: 2000,
      amount: 0.002,
      amountInUSD: 4,
      chainAggregation: [
        { token: { chainId: 1, address: "0x0", decimals: 18, realDecimals: 18 }, amount: 0.002, amountInUSD: 4, rawAmount: 0 },
      ],
    },
  ],
} as unknown as IAssetsResponse;

describe("account.summary (doc 06 — buying power over getPrimaryAssets)", () => {
  it("returns the doc-06 contract for a gated user", async () => {
    const id = await insertUser("DE");
    getPrimaryAssetsMock.mockResolvedValueOnce(ASSETS_FIXTURE);

    const s = await appRouter.createCaller(ctxFor(id)).account.summary();
    expect(s.buyingPowerUsd).toBeCloseTo(10, 10);
    expect(s.sources).toEqual([
      { chainId: 8453, name: "Base", usd: 6, pct: 60 },
      { chainId: 1, name: "Ethereum", usd: 4, pct: 40 },
    ]);
    expect(s.assets.map((a) => a.symbol)).toEqual(["USDC", "ETH"]);
    expect(Date.parse(s.asOf)).not.toBeNaN();
  });

  it("serves the 30s cache: a second call does not re-query Particle", async () => {
    const id = await insertUser("DE");
    getPrimaryAssetsMock.mockResolvedValue(ASSETS_FIXTURE);
    const caller = appRouter.createCaller(ctxFor(id));

    const first = await caller.account.summary();
    const second = await caller.account.summary();
    expect(second).toEqual(first); // same asOf — the cached object
    expect(getPrimaryAssetsMock).toHaveBeenCalledTimes(1);
  });

  it("on upstream failure serves the last-known summary with its OLD asOf (stale honesty)", async () => {
    const id = await insertUser("DE");
    getPrimaryAssetsMock.mockResolvedValueOnce(ASSETS_FIXTURE);
    const caller = appRouter.createCaller(ctxFor(id));
    const first = await caller.account.summary();

    // Age the cache entry past the TTL, then kill the upstream.
    const oldAsOf = new Date(Date.now() - 5 * 60_000).toISOString();
    summaryCache.set(id, { ...first, asOf: oldAsOf });
    getPrimaryAssetsMock.mockRejectedValueOnce(new Error("particle down"));

    const stale = await caller.account.summary();
    expect(stale.buyingPowerUsd).toBe(first.buyingPowerUsd);
    expect(stale.asOf).toBe(oldAsOf); // old timestamp → C1 renders the stale dot
  });

  it("fails honestly (BAD_GATEWAY) when upstream is down and nothing is cached", async () => {
    const id = await insertUser("DE");
    getPrimaryAssetsMock.mockRejectedValueOnce(new Error("particle down"));
    await expect(
      appRouter.createCaller(ctxFor(id)).account.summary(),
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });
  });

  it("stays behind the eligibility gate (FORBIDDEN with region unset)", async () => {
    const id = await insertUser(""); // gate not finalized
    await expect(
      appRouter.createCaller(ctxFor(id)).account.summary(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getPrimaryAssetsMock).not.toHaveBeenCalled();
  });
});
