import { events, getDb, users } from "@retenix/db";
import {
  SEND_EVENTS,
  SEND_INVITE_COPY,
  buildSignedMessage,
  computeInputHash,
  type SendExecutePayload,
  type SendReceiptPayload,
  type SigEnvelope,
} from "@retenix/shared";
import {
  CHAIN_ID,
  SUPPORTED_TOKEN_TYPE,
  primaryTokenFor,
} from "@retenix/ua";
import { and, eq, inArray } from "drizzle-orm";
import { Wallet, parseUnits } from "ethers";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashEmail } from "@/lib/emailHash";
import type { Context } from "../context";

/*
 * send.* route behavior over a real Postgres, network edges mocked: the UA
 * layer (@retenix/ua — pricing + verification poll), ENS, the settle-chain
 * RPC (block pin + Transfer-log scan), and the invite email. Signed envelopes
 * are real ethers signatures — sweep.test.ts / kill.test.ts conventions.
 */

vi.mock("@retenix/ua", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@retenix/ua")>();
  return {
    ...actual,
    createUa: vi.fn(() => ({}) as never),
    getPrimaryAssets: vi.fn(),
    pollToTerminal: vi.fn(),
  };
});
vi.mock("../lib/ens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ens")>();
  return { ...actual, resolveEnsName: vi.fn() };
});
vi.mock("../lib/settle-rpc", () => ({
  getSettleBlockNumber: vi.fn(),
  getSettleLogs: vi.fn(),
}));
vi.mock("../lib/invite", () => ({
  sendInviteEmail: vi.fn(async () => ({ sent: false })),
}));

const ua = await import("@retenix/ua");
const primariesMock = vi.mocked(ua.getPrimaryAssets);
const pollMock = vi.mocked(ua.pollToTerminal);
const ensMod = await import("../lib/ens");
const ensMock = vi.mocked(ensMod.resolveEnsName);
const settle = await import("../lib/settle-rpc");
const blockMock = vi.mocked(settle.getSettleBlockNumber);
const logsMock = vi.mocked(settle.getSettleLogs);
const invite = await import("../lib/invite");
const inviteMock = vi.mocked(invite.sendInviteEmail);
const { __resetSendResolveRateLimit } = await import("../lib/send-rate-limit");
const { appRouter } = await import("./index");

const db = getDb();
const senderWallet = Wallet.createRandom();
const recipientWallet = Wallet.createRandom();
const SENDER_EMAIL = "mark-send-test@example.com";
const RECIPIENT_EMAIL = "ana-send-test@example.com";

const USDC_ARB = primaryTokenFor(
  SUPPORTED_TOKEN_TYPE.USDC,
  CHAIN_ID.ARBITRUM_MAINNET_ONE,
)!;

let senderId: string;
let recipientId: string;

const ctx = (): Context => ({
  db,
  session: {
    userId: senderId,
    eoaAddr: senderWallet.address,
    issuer: "did:test",
    region: "DE",
  },
  headers: new Headers(),
  resHeaders: new Headers(),
});

const caller = () => appRouter.createCaller(ctx());

let nonceCounter = Date.now();
const nextNonce = () => ++nonceCounter;

async function sign(payload: unknown): Promise<SigEnvelope> {
  const nonce = nextNonce();
  const expiry = Math.floor(Date.now() / 1000) + 240;
  const message = buildSignedMessage({
    route: "send.execute",
    inputHash: computeInputHash(payload),
    nonce,
    expiry,
  });
  return { signature: await senderWallet.signMessage(message), nonce, expiry };
}

async function execute(payload: SendExecutePayload) {
  return caller().send.execute({ payload, sig: await sign(payload) });
}

const authorizeEmail = (amountUsd = 2) => ({
  phase: "authorize" as const,
  to: { kind: "email" as const, value: RECIPIENT_EMAIL },
  amountUsd,
  senderEmail: SENDER_EMAIL,
});

/** Primary feed with $100 spendable USDC (and SOL for withdraw cases). */
function fundPrimaries() {
  primariesMock.mockResolvedValue({
    assets: [
      { tokenType: "usdc", price: 1, amountInUSD: 100 },
      { tokenType: "sol", price: 160, amountInUSD: 50 },
    ],
  } as never);
}

/** A finished poll whose payload shows `units` of `tokenAddress` leaving the
 *  sender's account — the verification happy path. */
function finishedPoll(units: string, tokenAddress = USDC_ARB.address) {
  pollMock.mockResolvedValue({
    outcome: "finished",
    t: {
      smartAccountOptions: { ownerAddress: senderWallet.address },
      tokenChanges: {
        decr: [{ token: { address: tokenAddress }, amount: units, amountInUSD: 2 }],
      },
    },
  } as never);
}

const deliveredLog = (units: string, decimals = 6) => [
  { data: "0x" + parseUnits(units, decimals).toString(16) },
];

async function wipeUsers() {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      inArray(users.emailHash, [hashEmail(SENDER_EMAIL), hashEmail(RECIPIENT_EMAIL)]),
    );
  for (const row of rows) {
    await db.delete(events).where(eq(events.userId, row.id));
    await db.delete(users).where(eq(users.id, row.id));
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  __resetSendResolveRateLimit();
  await wipeUsers();
  const [s] = await db
    .insert(users)
    .values({
      emailHash: hashEmail(SENDER_EMAIL),
      eoaAddr: senderWallet.address,
      uaEvmAddr: senderWallet.address,
      uaSolAddr: "",
      region: "DE",
    })
    .returning({ id: users.id });
  senderId = s.id;
  const [r] = await db
    .insert(users)
    .values({
      emailHash: hashEmail(RECIPIENT_EMAIL),
      eoaAddr: recipientWallet.address,
      uaEvmAddr: recipientWallet.address,
      uaSolAddr: "",
      region: "DE",
    })
    .returning({ id: users.id });
  recipientId = r.id;

  fundPrimaries();
  blockMock.mockResolvedValue(1000);
  logsMock.mockResolvedValue([]);
});
afterAll(wipeUsers);

// ---------------------------------------------------------------------------
// send.resolve
// ---------------------------------------------------------------------------

describe("send.resolve", () => {
  it("registered email → status only, NEVER an address (oracle posture)", async () => {
    const res = await caller().send.resolve({
      to: { kind: "email", value: RECIPIENT_EMAIL },
    });
    expect(res).toEqual({ status: "registered", display: "a•••@example.com" });
    expect("address" in res && res.address).toBeFalsy();
  });

  it("unregistered email → unregistered (the invite pre-flag)", async () => {
    const res = await caller().send.resolve({
      to: { kind: "email", value: "stranger-send-test@example.com" },
    });
    expect(res.status).toBe("unregistered");
  });

  it("ENS hit/miss → resolved with address / not-found", async () => {
    const addr = Wallet.createRandom().address;
    ensMock.mockResolvedValueOnce(addr);
    expect(
      await caller().send.resolve({ to: { kind: "ens", value: "ana.eth" } }),
    ).toEqual({ status: "resolved", address: addr, display: "ana.eth" });

    ensMock.mockResolvedValueOnce(null);
    expect(
      (await caller().send.resolve({ to: { kind: "ens", value: "nobody.eth" } })).status,
    ).toBe("not-found");
  });

  it("bad checksum → invalid", async () => {
    const bad =
      senderWallet.address.slice(0, -1) +
      (senderWallet.address.endsWith("a") ? "b" : "a");
    expect(
      (await caller().send.resolve({ to: { kind: "address", value: bad } })).status,
    ).toBe("invalid");
  });

  it("rate-limits the lookup oracle", async () => {
    for (let i = 0; i < 20; i++) {
      await caller().send.resolve({ to: { kind: "email", value: RECIPIENT_EMAIL } });
    }
    await expect(
      caller().send.resolve({ to: { kind: "email", value: RECIPIENT_EMAIL } }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

// ---------------------------------------------------------------------------
// authorize
// ---------------------------------------------------------------------------

describe("send.execute authorize", () => {
  it("registered email: pins USDC@settle-chain target with the recipient's EOA", async () => {
    const res = await execute(authorizeEmail());
    if (res.phase !== "authorize" || res.authorization.invited) throw new Error("shape");
    const { target, executionId } = res.authorization;
    expect(target).toMatchObject({
      address: recipientWallet.address,
      token: {
        chainId: 42161,
        address: USDC_ARB.address,
        decimals: 6, // realDecimals — never the 18-dp normalized figure
        symbol: "USDC",
      },
      amountUnits: "2",
      amountUsd: 2,
      display: "a•••@example.com",
      withdraw: false,
      recipientUserId: recipientId,
      senderDisplay: "m•••@example.com",
    });

    // the authorized row pins the same target + the delivery-scan block
    const rows = await db
      .select({ payloadJson: events.payloadJson })
      .from(events)
      .where(and(eq(events.userId, senderId), eq(events.type, SEND_EVENTS.authorized)));
    expect(rows).toHaveLength(1);
    expect(rows[0].payloadJson).toMatchObject({ executionId, fromBlock: 1000 });
  });

  it("unregistered email: invite copy verbatim, NO authorization, NO funds path", async () => {
    const payload: SendExecutePayload = {
      phase: "authorize",
      to: { kind: "email", value: "stranger-send-test@example.com" },
      amountUsd: 2,
    };
    const res = await execute(payload);
    if (res.phase !== "authorize") throw new Error("shape");
    expect(res.authorization).toEqual({ invited: true, message: SEND_INVITE_COPY });
    expect(inviteMock).toHaveBeenCalledTimes(1);

    const authorized = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.userId, senderId), eq(events.type, SEND_EVENTS.authorized)));
    expect(authorized).toHaveLength(0);
    const invited = await db
      .select({ payloadJson: events.payloadJson })
      .from(events)
      .where(and(eq(events.userId, senderId), eq(events.type, SEND_EVENTS.invited)));
    expect(invited).toHaveLength(1);

    // …and a repeat within the dedupe window sends no second email
    await execute(payload);
    expect(inviteMock).toHaveBeenCalledTimes(1);
  });

  it("senderEmail must hash to the session user's email_hash", async () => {
    await expect(
      execute({ ...authorizeEmail(), senderEmail: "impostor@example.com" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /doesn't match/ });
  });

  it("withdraw: valid (asset, network) pair pins the pair's token", async () => {
    const res = await execute({
      phase: "authorize",
      // Solana-network withdraws validate base58, not EVM checksum
      to: { kind: "address", value: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      amountUsd: 2,
      asset: "sol",
      chainId: 101,
    });
    if (res.phase !== "authorize" || res.authorization.invited) throw new Error("shape");
    expect(res.authorization.target).toMatchObject({
      withdraw: true,
      amountUnits: "0.0125", // $2 at $160, floor-truncated to 9dp
      token: { chainId: 101, symbol: "SOL", decimals: 9 },
    });
  });

  it("withdraw: invalid pair / half-specified pair are refused", async () => {
    await expect(
      execute({
        phase: "authorize",
        to: { kind: "address", value: recipientWallet.address },
        amountUsd: 2,
        asset: "sol",
        chainId: 42161,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /can't arrive there/ });
    await expect(
      execute({
        phase: "authorize",
        to: { kind: "address", value: recipientWallet.address },
        amountUsd: 2,
        asset: "sol",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /chosen together/ });
  });

  it("amount above the spendable balance is refused with the honest cap", async () => {
    await expect(execute(authorizeEmail(150))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: /you can send up to \$100\.00/,
    });
  });

  it("self-sends are refused", async () => {
    await expect(
      execute({
        phase: "authorize",
        to: { kind: "address", value: senderWallet.address },
        amountUsd: 2,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /own address/ });
  });

  it("a second authorize while one is un-receipted → CONFLICT (double-tap guard)", async () => {
    await execute(authorizeEmail());
    await expect(execute(authorizeEmail())).rejects.toMatchObject({
      code: "CONFLICT",
      message: /already in progress/,
    });
  });
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

async function authorizedExecution(payload: SendExecutePayload = authorizeEmail()) {
  const res = await execute(payload);
  if (res.phase !== "authorize" || res.authorization.invited) throw new Error("shape");
  return res.authorization;
}

describe("send.execute report", () => {
  it("verified finished send: sender receipt + chain-proven recipient row, exactly once", async () => {
    const { executionId } = await authorizedExecution();
    finishedPoll("2");
    logsMock.mockResolvedValue(deliveredLog("2"));

    const res = await execute({
      phase: "report",
      executionId,
      transactionId: "tx-send-1",
      clientOutcome: "finished",
      feesQuoted: { gas: 0.02, service: 0.02, lp: 0.01, total: 0.05 },
    });
    if (res.phase !== "report") throw new Error("shape");
    expect(res.receipt).toMatchObject({
      outcome: "finished",
      serverVerified: true,
      receipt: "Sent $2.00 to a•••@example.com · fees $0.05 · view onchain",
      feeSource: "quoted",
    });

    const received = await db
      .select({ payloadJson: events.payloadJson })
      .from(events)
      .where(and(eq(events.userId, recipientId), eq(events.type, SEND_EVENTS.received)));
    expect(received).toHaveLength(1);
    expect(received[0].payloadJson).toMatchObject({
      receipt: "Received $2.00 from m•••@example.com",
      usd: 2,
      fromDisplay: "m•••@example.com",
    });

    // idempotent convergence: a duplicate report returns the SAME receipt and
    // writes nothing new on either side
    const again = await execute({
      phase: "report",
      executionId,
      transactionId: "tx-send-1",
      clientOutcome: "finished",
    });
    if (again.phase !== "report") throw new Error("shape");
    expect(again.receipt).toEqual(res.receipt);
    const receipts = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.userId, senderId), eq(events.type, SEND_EVENTS.receipt)));
    expect(receipts).toHaveLength(1);
    expect(
      await db
        .select({ id: events.id })
        .from(events)
        .where(
          and(eq(events.userId, recipientId), eq(events.type, SEND_EVENTS.received)),
        ),
    ).toHaveLength(1);
  });

  it("delivery unproven → NO recipient row; the sender's receipt still honest", async () => {
    const { executionId } = await authorizedExecution();
    finishedPoll("2");
    logsMock.mockResolvedValue([]); // nothing arrived at the recipient

    const res = await execute({
      phase: "report",
      executionId,
      transactionId: "tx-send-2",
      clientOutcome: "finished",
    });
    if (res.phase !== "report") throw new Error("shape");
    expect(res.receipt.outcome).toBe("finished");
    expect(
      await db
        .select({ id: events.id })
        .from(events)
        .where(
          and(eq(events.userId, recipientId), eq(events.type, SEND_EVENTS.received)),
        ),
    ).toHaveLength(0);
  });

  it("forced-swap guard: the polled tx must move the PINNED token in the PINNED amount", async () => {
    const { executionId } = await authorizedExecution();
    // wrong token entirely
    finishedPoll("2", "0x" + "99".repeat(20));
    let res = await execute({
      phase: "report",
      executionId,
      transactionId: "tx-send-3",
      clientOutcome: "finished",
    });
    if (res.phase !== "report") throw new Error("shape");
    expect(res.receipt).toMatchObject({
      outcome: "unverified",
      serverVerified: false,
      error: "couldn't confirm what moved",
    });

    // right token, wrong amount (beyond tolerance) — new execution
    const second = await authorizedExecution();
    finishedPoll("3");
    res = await execute({
      phase: "report",
      executionId: second.executionId,
      transactionId: "tx-send-4",
      clientOutcome: "finished",
    });
    if (res.phase !== "report") throw new Error("shape");
    expect(res.receipt).toMatchObject({
      outcome: "unverified",
      error: "amount did not match",
    });
  });

  it("a foreign transaction is a failed claim", async () => {
    const { executionId } = await authorizedExecution();
    pollMock.mockResolvedValue({
      outcome: "finished",
      t: { smartAccountOptions: { ownerAddress: Wallet.createRandom().address } },
    } as never);
    const res = await execute({
      phase: "report",
      executionId,
      transactionId: "tx-send-5",
      clientOutcome: "finished",
    });
    if (res.phase !== "report") throw new Error("shape");
    expect(res.receipt).toMatchObject({
      outcome: "failed",
      error: "did not match this account",
    });
  });

  it("refund terminal → the doc-08 returned wording", async () => {
    const { executionId } = await authorizedExecution();
    pollMock.mockResolvedValue({
      outcome: "refunded",
      t: { smartAccountOptions: { ownerAddress: senderWallet.address } },
    } as never);
    const res = await execute({
      phase: "report",
      executionId,
      transactionId: "tx-send-6",
      clientOutcome: "refunded",
    });
    if (res.phase !== "report") throw new Error("shape");
    expect(res.receipt.outcome).toBe("refunded");
    expect(res.receipt.receipt).toBe("Didn't complete — your $2.00 was returned");
  });

  it("non-terminal poll → CONFLICT still settling (the runner re-reports)", async () => {
    const { executionId } = await authorizedExecution();
    pollMock.mockResolvedValue({ outcome: "timeout", t: {} } as never);
    await expect(
      execute({
        phase: "report",
        executionId,
        transactionId: "tx-send-7",
        clientOutcome: "finished",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: /still settling/ });
  });

  it("no transactionId → nothing left the account", async () => {
    const { executionId } = await authorizedExecution();
    const res = await execute({
      phase: "report",
      executionId,
      clientOutcome: "failed",
    });
    if (res.phase !== "report") throw new Error("shape");
    expect(res.receipt).toMatchObject({ outcome: "failed", serverVerified: true });
    expect(res.receipt.receipt).toContain("never left your account");
  });

  it("unknown executionId → BAD_REQUEST", async () => {
    await expect(
      execute({
        phase: "report",
        executionId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
        clientOutcome: "finished",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /unknown/ });
  });

  it("one transactionId binds to ONE receipt row (rebind → CONFLICT)", async () => {
    const first = await authorizedExecution();
    finishedPoll("2");
    await execute({
      phase: "report",
      executionId: first.executionId,
      transactionId: "tx-send-8",
      clientOutcome: "finished",
    });

    const second = await authorizedExecution();
    finishedPoll("2");
    await expect(
      execute({
        phase: "report",
        executionId: second.executionId,
        transactionId: "tx-send-8",
        clientOutcome: "finished",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: /already recorded/ });
  });

  it("sol withdraw: receipt names the network + carries the ledgerFill", async () => {
    const auth = await authorizedExecution({
      phase: "authorize",
      to: {
        kind: "address",
        value: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
      amountUsd: 2,
      asset: "sol",
      chainId: 101,
    });
    const solToken = primaryTokenFor(SUPPORTED_TOKEN_TYPE.SOL, CHAIN_ID.SOLANA_MAINNET)!;
    finishedPoll("0.0125", solToken.address);

    const res = await execute({
      phase: "report",
      executionId: auth.executionId,
      transactionId: "tx-send-9",
      clientOutcome: "finished",
    });
    if (res.phase !== "report") throw new Error("shape");
    expect(res.receipt).toMatchObject({
      outcome: "finished",
      withdraw: true,
      network: "Solana",
      symbol: "SOL",
      ledgerFill: { assetId: "sol", qty: 0.0125, usd: 2 },
    });
    expect(res.receipt.receipt).toContain("Withdrew $2.00 of SOL to ");
    expect(res.receipt.receipt).toContain(" on Solana · fees ");
  });

  it("usdc withdraw: NO ledgerFill (not a ledger-tracked asset)", async () => {
    const auth = await authorizedExecution({
      phase: "authorize",
      to: { kind: "address", value: recipientWallet.address },
      amountUsd: 2,
      asset: "usdc",
      chainId: 42161,
    });
    finishedPoll("2");
    const res = await execute({
      phase: "report",
      executionId: auth.executionId,
      transactionId: "tx-send-10",
      clientOutcome: "finished",
    });
    if (res.phase !== "report") throw new Error("shape");
    const receipt = res.receipt as SendReceiptPayload;
    expect(receipt.withdraw).toBe(true);
    expect(receipt.ledgerFill).toBeUndefined();
  });
});
