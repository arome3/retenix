import { events, getDb, users } from "@retenix/db";
import {
  SWEEP_EVENTS,
  buildSignedMessage,
  computeInputHash,
  sweepReceiptHeadline,
  type SigEnvelope,
  type SweepExecutePayload,
  type SweepReceipt,
} from "@retenix/shared";
import { pollToTerminal } from "@retenix/ua";
import { and, eq, sql } from "drizzle-orm";
import { Wallet } from "ethers";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import type { DustItem, DustScanResult } from "../lib/dust";

/*
 * sweep.preview / sweep.execute route behavior over a real Postgres, with the
 * network edges mocked: the scanner (lib/dust) and the UA layer (@retenix/ua).
 * The signed envelope is real — an ethers Wallet stands in for Magic, exactly
 * like signed-mutation.test.ts.
 */

vi.mock("../lib/dust", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/dust")>();
  return { ...actual, scanDust: vi.fn(), defaultDustDeps: vi.fn(() => ({}) as never) };
});
vi.mock("@retenix/ua", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@retenix/ua")>();
  return {
    ...actual,
    createUa: vi.fn(() => ({}) as never),
    createSellTransaction: vi.fn(),
    pollToTerminal: vi.fn(),
  };
});

const dust = await import("../lib/dust");
const scanDustMock = vi.mocked(dust.scanDust);
const pollMock = vi.mocked(pollToTerminal);
const { appRouter } = await import("./index");

const db = getDb();
const wallet = Wallet.createRandom();
const EMAIL_HASH = "0xsweep-route-test-emailhash";
const ROUTE = "sweep.execute";

let userId: string;

const ctx = (region = "DE"): Context => ({
  db,
  session: { userId, eoaAddr: wallet.address, issuer: "did:test", region },
  headers: new Headers(),
  resHeaders: new Headers(),
});

// Nonces must be strictly increasing per user (trpc.ts consumeNonce) — a
// monotonic counter, never raw Date.now() (two same-ms signs would collide).
let nonceCounter = Date.now();
const nextNonce = () => ++nonceCounter;

async function sign(payload: SweepExecutePayload): Promise<SigEnvelope> {
  const nonce = nextNonce();
  const expiry = Math.floor(Date.now() / 1000) + 240;
  const message = buildSignedMessage({
    route: ROUTE,
    inputHash: computeInputHash(payload),
    nonce,
    expiry,
  });
  return { signature: await wallet.signMessage(message), nonce, expiry };
}

async function execute(payload: SweepExecutePayload, c: Context = ctx()) {
  return appRouter.createCaller(c).sweep.execute({ payload, sig: await sign(payload) });
}

const ITEMS: DustItem[] = [
  {
    chainId: 8453,
    token: "0xAAA0000000000000000000000000000000000001",
    symbol: "DEGEN",
    usd: 15.11,
    amountHuman: "30.22",
    feesQuoted: { gas: 0.02, service: 0.01, lp: 0, total: 0.03 },
  },
  {
    chainId: 101,
    token: "BonkMint1111111111111111111111111111111111",
    symbol: "BONK",
    usd: 8,
    amountHuman: "800",
    feesQuoted: { gas: 0.01, service: 0.01, lp: 0, total: 0.02 },
  },
];

const SCAN: DustScanResult = {
  totalUsd: 23.11,
  items: ITEMS,
  skipped: [{ chainId: 196, reason: "source-unsupported" }],
  fees: { gas: 0.03, service: 0.02, lp: 0, total: 0.05 },
};

const terminal = (outcome: "finished" | "refunded" | "timeout", t: object = {}) =>
  ({ outcome, t: { status: 7, ...t } }) as never;

async function authorize(): Promise<string> {
  scanDustMock.mockResolvedValueOnce(SCAN);
  const res = await execute({ phase: "authorize" });
  if (res.phase !== "authorize") throw new Error("expected authorize response");
  return res.authorization.executionId!;
}

function legsFor(executionId: string) {
  return {
    phase: "report" as const,
    executionId,
    legs: [
      {
        chainId: 8453,
        token: ITEMS[0].token,
        transactionId: "tx-base-1",
        clientOutcome: "finished" as const,
        feesQuoted: ITEMS[0].feesQuoted,
      },
      {
        chainId: 101,
        token: ITEMS[1].token,
        transactionId: "tx-sol-1",
        clientOutcome: "finished" as const,
        feesQuoted: ITEMS[1].feesQuoted,
      },
    ],
  };
}

async function receiptRows(): Promise<SweepReceipt[]> {
  const rows = await db
    .select({ payloadJson: events.payloadJson })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.type, SWEEP_EVENTS.receipt)));
  return rows.map((r) => r.payloadJson as SweepReceipt);
}

async function cleanup() {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.emailHash, EMAIL_HASH));
  for (const row of rows) {
    await db.delete(events).where(eq(events.userId, row.id));
    await db.delete(users).where(eq(users.id, row.id));
  }
}

beforeEach(async () => {
  await cleanup();
  // clearAllMocks leaves mockResolvedValueOnce queues behind — reset the two
  // behavior-carrying mocks fully so no test inherits another's script.
  scanDustMock.mockReset();
  pollMock.mockReset();
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
afterAll(cleanup);

describe("sweep.preview", () => {
  it("returns the scan plus prompt state, behind the gate", async () => {
    scanDustMock.mockResolvedValueOnce(SCAN);
    const res = await appRouter.createCaller(ctx()).sweep.preview();
    expect(res.totalUsd).toBe(23.11);
    expect(res.items).toEqual(
      ITEMS.map(({ chainId, token, symbol, usd }) => ({ chainId, token, symbol, usd })),
    );
    expect(res.skipped).toEqual(SCAN.skipped);
    expect(res.hasSwept).toBe(false);
    expect(res.dismissed).toBe(false);
  });

  it("is FORBIDDEN pre-gate", async () => {
    await db.update(users).set({ region: "" }).where(eq(users.id, userId));
    await expect(appRouter.createCaller(ctx("")).sweep.preview()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(scanDustMock).not.toHaveBeenCalled();
  });

  it("reports hasSwept/dismissed from events", async () => {
    await db.insert(events).values([
      { userId, type: SWEEP_EVENTS.receipt, payloadJson: { executionId: "x" } },
      { userId, type: SWEEP_EVENTS.dismissed, payloadJson: {} },
    ]);
    scanDustMock.mockResolvedValueOnce(SCAN);
    const res = await appRouter.createCaller(ctx()).sweep.preview();
    expect(res.hasSwept).toBe(true);
    expect(res.dismissed).toBe(true);
  });
});

describe("sweep.execute — authorize", () => {
  it("persists the server-derived item list and returns it", async () => {
    const executionId = await authorize();
    expect(executionId).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await db
      .select({ payloadJson: events.payloadJson })
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.type, SWEEP_EVENTS.authorized)));
    expect(rows).toHaveLength(1);
    expect(rows[0].payloadJson).toMatchObject({
      executionId,
      totalUsd: 23.11,
      items: ITEMS,
    });
  });

  it("authorizes nothing when there is no dust (no event row)", async () => {
    scanDustMock.mockResolvedValueOnce({ ...SCAN, items: [], totalUsd: 0 });
    const res = await execute({ phase: "authorize" });
    expect(res.phase).toBe("authorize");
    if (res.phase !== "authorize") return;
    expect(res.authorization.executionId).toBeNull();
    const rows = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.type, SWEEP_EVENTS.authorized)));
    expect(rows).toHaveLength(0);
  });

  it("CONFLICTs a second authorize while one is un-receipted (double-tap guard)", async () => {
    await authorize();
    scanDustMock.mockResolvedValueOnce(SCAN);
    await expect(execute({ phase: "authorize" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("requires a real signature (impostor rejected before any scan)", async () => {
    const payload: SweepExecutePayload = { phase: "authorize" };
    const impostor = Wallet.createRandom();
    const nonce = Date.now();
    const expiry = Math.floor(Date.now() / 1000) + 240;
    const message = buildSignedMessage({
      route: ROUTE,
      inputHash: computeInputHash(payload),
      nonce,
      expiry,
    });
    const sig = { signature: await impostor.signMessage(message), nonce, expiry };
    await expect(
      appRouter.createCaller(ctx()).sweep.execute({ payload, sig }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(scanDustMock).not.toHaveBeenCalled();
  });
});

describe("sweep.execute — report", () => {
  it("writes EXACTLY ONE sweep.receipt with per-leg detail (PS-F2-AC2)", async () => {
    const executionId = await authorize();
    pollMock.mockResolvedValue(terminal("finished"));

    const res = await execute(legsFor(executionId));
    expect(res.phase).toBe("report");
    if (res.phase !== "report") return;
    const receipt = res.receipt;

    expect(receipt.headline).toBe("+$23.11 rescued from 2 networks.");
    expect(receipt.headline).toBe(sweepReceiptHeadline(23.11, 2));
    expect(receipt.succeededUsd).toBeCloseTo(23.11, 10);
    expect(receipt.networkCount).toBe(2);
    expect(receipt.legs).toHaveLength(2);
    for (const leg of receipt.legs) {
      expect(leg.outcome).toBe("finished");
      expect(leg.serverVerified).toBe(true);
      expect(leg.activityUrl).toContain("universalx.app/activity/details?id=");
      expect(["Base", "Solana"]).toContain(leg.network);
    }

    const rows = await receiptRows();
    expect(rows).toHaveLength(1); // exactly one aggregate receipt event
    expect(rows[0].executionId).toBe(executionId);
  });

  it("re-reporting converges on the SAME receipt (idempotent, still one row)", async () => {
    const executionId = await authorize();
    pollMock.mockResolvedValue(terminal("finished"));

    const first = await execute(legsFor(executionId));
    const second = await execute(legsFor(executionId));
    if (first.phase !== "report" || second.phase !== "report") throw new Error();
    expect(second.receipt.createdAt).toBe(first.receipt.createdAt);
    expect(await receiptRows()).toHaveLength(1);
  });

  it("partial failure: continue-and-report — headline counts only what succeeded", async () => {
    const executionId = await authorize();
    // Base leg finishes; Solana leg fails client-side (no transactionId).
    pollMock.mockResolvedValue(terminal("finished"));
    const res = await execute({
      phase: "report",
      executionId,
      legs: [
        {
          chainId: 8453,
          token: ITEMS[0].token,
          transactionId: "tx-base-1",
          clientOutcome: "finished",
          feesQuoted: ITEMS[0].feesQuoted,
        },
        {
          chainId: 101,
          token: ITEMS[1].token,
          clientOutcome: "failed",
          error: "quote expired",
        },
      ],
    });
    if (res.phase !== "report") throw new Error();
    const receipt = res.receipt;
    expect(receipt.headline).toBe("+$15.11 rescued from 1 network.");
    expect(receipt.succeededUsd).toBeCloseTo(15.11, 10);
    const failed = receipt.legs.find((l) => l.chainId === 101);
    expect(failed).toMatchObject({ outcome: "failed", error: "quote expired" });
  });

  it("a REFUND terminal renders an honest returned line, never success", async () => {
    const executionId = await authorize();
    pollMock
      .mockResolvedValueOnce(terminal("finished"))
      .mockResolvedValueOnce(terminal("refunded", { status: 9 }));
    const res = await execute(legsFor(executionId));
    if (res.phase !== "report") throw new Error();
    const refunded = res.receipt.legs.find((l) => l.chainId === 101);
    expect(refunded).toMatchObject({
      outcome: "refunded",
      serverVerified: true,
      error: "returned",
    });
    expect(res.receipt.succeededUsd).toBeCloseTo(15.11, 10);
  });

  it("unauthorized legs are ignored — usd comes from the AUTHORIZED items only", async () => {
    const executionId = await authorize();
    pollMock.mockResolvedValue(terminal("finished"));
    const res = await execute({
      phase: "report",
      executionId,
      legs: [
        {
          chainId: 8453,
          token: ITEMS[0].token,
          transactionId: "tx-base-1",
          clientOutcome: "finished",
        },
        {
          // Never authorized: a client-invented token must not enter the receipt.
          chainId: 1,
          token: "0xEV11000000000000000000000000000000000bad",
          transactionId: "tx-forged",
          clientOutcome: "finished",
        },
      ],
    });
    if (res.phase !== "report") throw new Error();
    expect(res.receipt.ignored).toEqual([
      expect.objectContaining({ chainId: 1, reason: "unauthorized" }),
    ]);
    // The unattempted BONK item shows up as an honest failed leg.
    const unattempted = res.receipt.legs.find((l) => l.chainId === 101);
    expect(unattempted).toMatchObject({ outcome: "failed", error: "not attempted" });
    expect(res.receipt.succeededUsd).toBeCloseTo(15.11, 10);
  });

  it("a transaction owned by someone else never counts", async () => {
    const executionId = await authorize();
    pollMock
      .mockResolvedValueOnce(
        terminal("finished", {
          smartAccountOptions: { ownerAddress: "0x9999999999999999999999999999999999999999" },
        }),
      )
      .mockResolvedValueOnce(terminal("finished"));
    const res = await execute(legsFor(executionId));
    if (res.phase !== "report") throw new Error();
    const foreign = res.receipt.legs.find((l) => l.chainId === 8453);
    expect(foreign).toMatchObject({
      outcome: "failed",
      serverVerified: true,
      error: "did not match this account",
    });
    expect(res.receipt.succeededUsd).toBeCloseTo(8, 10);
  });

  it("an unverifiable lookup carries the client claim, flagged serverVerified:false", async () => {
    const executionId = await authorize();
    pollMock
      .mockRejectedValueOnce(new Error("particle 500"))
      .mockResolvedValueOnce(terminal("finished"));
    const res = await execute(legsFor(executionId));
    if (res.phase !== "report") throw new Error();
    const unverified = res.receipt.legs.find((l) => l.chainId === 8453);
    expect(unverified).toMatchObject({ outcome: "finished", serverVerified: false });
  });

  it("rejects a report for an unknown executionId", async () => {
    await expect(
      execute({
        phase: "report",
        executionId: "0d5c1f9a-8f2b-4c39-9a55-8e29a1f4b7c1",
        legs: [],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("sweep.dismiss", () => {
  it("records one sweep.dismissed event, idempotently", async () => {
    const caller = appRouter.createCaller(ctx());
    await caller.sweep.dismiss();
    await caller.sweep.dismiss();
    const rows = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.type, SWEEP_EVENTS.dismissed)));
    expect(rows).toHaveLength(1);
  });
});

describe("nonce hygiene across the two phases", () => {
  it("each phase consumes its own strictly-increasing nonce", async () => {
    const executionId = await authorize();
    pollMock.mockResolvedValue(terminal("finished"));
    await execute(legsFor(executionId));

    const nonces = await db.execute(
      sql`select (payload_json->>'nonce')::numeric as nonce from events
          where user_id = ${userId} and type = 'sig.nonce' order by nonce asc`,
    );
    expect(nonces.rows.length).toBeGreaterThanOrEqual(2);
  });
});
