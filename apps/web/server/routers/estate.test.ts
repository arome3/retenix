import { estates, events, getDb, plans, users } from "@retenix/db";
import {
  ESTATE_CHAIN_IDS,
  ESTATE_EVENTS,
  beneficiaryHashFor,
  buildSignedMessage,
  computeInputHash,
  mintClaimToken,
  type EstateEnrollPayload,
  type SigEnvelope,
} from "@retenix/shared";
import { decryptEnvelope, devEscrowProvider } from "@retenix/shared/escrow";
import { and, eq, like, or } from "drizzle-orm";
import { Wallet } from "ethers";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "../context";
import type { PlanRelay } from "../lib/relay-factory";

/*
 * estate.* route behavior over a real Postgres, network edges mocked: the
 * relay (setPlanRelayFactory) and the per-chain nonce reader
 * (setEstateChainReaderFactory). Envelope crypto is REAL (the dev escrow
 * provider from the test env) — enroll's ciphertexts are decrypted and
 * asserted. Signed envelopes are real ethers signatures (kill.test.ts
 * conventions).
 */
const { setPlanRelayFactory, resetPlanRelayFactory } = await import("../lib/relay-factory");
const estateLib = await import("../lib/estate");
const { appRouter } = await import("./index");

const db = getDb();
const wallet = Wallet.createRandom();
const heirWallet = Wallet.createRandom();
const EMAIL_HASH = "0xestate-route-test-owner";
// mirrors apps/web/lib/emailHash.ts (sha256 of lowercased email)
const { hashEmail } = await import("@/lib/emailHash");

const ARB_DELEGATE = "0x92427d60cda5f63740d95Ad972dFA5A115AdD8d0";
const ZERO = "0x0000000000000000000000000000000000000000";

let userId: string;
let heirUserId: string;

const ctx = (session: Context["session"]): Context => ({
  db,
  session,
  headers: new Headers(),
  resHeaders: new Headers(),
});

const ownerCaller = () =>
  appRouter.createCaller(
    ctx({ userId, eoaAddr: wallet.address, issuer: "did:test", region: "DE" }),
  );
const heirCaller = () =>
  appRouter.createCaller(
    ctx({ userId: heirUserId, eoaAddr: heirWallet.address, issuer: "did:heir", region: "" }),
  );
const anonCaller = () => appRouter.createCaller(ctx(null));

let nonceCounter = Date.now();
async function sign(route: string, payload: unknown): Promise<SigEnvelope> {
  const nonce = ++nonceCounter;
  const expiry = Math.floor(Date.now() / 1000) + 240;
  const message = buildSignedMessage({
    route,
    inputHash: computeInputHash(payload),
    nonce,
    expiry,
  });
  return { signature: await wallet.signMessage(message), nonce, expiry };
}

interface RelayCalls {
  enroll: { beneficiaryHash: string; inactivitySecs: bigint; nonce: bigint }[];
  checkIn: number;
}

function stubRelay(over: Partial<PlanRelay> = {}): PlanRelay & { calls: RelayCalls } {
  const calls: RelayCalls = { enroll: [], checkIn: 0 };
  const relay: PlanRelay = {
    domain: { chainId: 421614, contract: "0x4549a91b4727537372925C8C589d9BCfF9B6c261" },
    authNonce: async () => 3n,
    agentAddress: async () => wallet.address,
    buildCreatePlanDigest: async () => `0x${"cd".repeat(32)}`,
    createPlan: async () => ({ txHash: "0xtx", planId: 42n }),
    revokePlanFor: async () => ({ txHash: "0xrevoke" }),
    verifyRevokeAll: () => true,
    revokeAll: async () => ({ txHash: "0xrevokeall" }),
    txStatus: async () => "confirmed" as const,
    enrollEstate: async (args) => {
      calls.enroll.push({
        beneficiaryHash: args.beneficiaryHash,
        inactivitySecs: args.inactivitySecs,
        nonce: args.nonce,
      });
      return { txHash: "0xenrolltx" };
    },
    checkIn: async () => {
      calls.checkIn += 1;
      return { txHash: "0xcheckintx" };
    },
    estateOf: async () => ({
      beneficiaryHash: `0x${"ab".repeat(32)}`,
      inactivitySecs: 120n,
      lastCheckIn: BigInt(Math.floor(Date.now() / 1000)),
      claimReadyAt: 0n,
      status: 1,
    }),
    ...over,
  };
  return Object.assign(relay, { calls });
}

// ONE relay instance per test (getPlanRelay() is called per request — a
// fresh stub each time would zero the call counters between requests)
let memoRelay: (PlanRelay & { calls: RelayCalls }) | null = null;
function useRelay(relay: PlanRelay & { calls: RelayCalls }): void {
  memoRelay = relay;
  setPlanRelayFactory(() => memoRelay!);
}
function currentRelay(): PlanRelay & { calls: RelayCalls } {
  if (!memoRelay) throw new Error("relay not initialized");
  return memoRelay;
}

function tuplesFor(delegates: Record<number, string>) {
  return ESTATE_CHAIN_IDS.map((chainId) => ({
    chainId,
    address: delegates[chainId] ?? ZERO,
    nonce: 0,
    yParity: 0 as const,
    r: `0x${"11".repeat(32)}`,
    s: `0x${"22".repeat(32)}`,
  }));
}

/** Tuples matching the test env's delegate record (Arbitrum real, rest zero). */
const validTuples = () => tuplesFor({ 42161: ARB_DELEGATE });

function enrollPayload(over: Partial<EstateEnrollPayload> = {}): EstateEnrollPayload {
  return {
    beneficiaryEmail: "heir@example.com",
    ownerDisplayName: "Amaka",
    inactivityDays: 180,
    salt: `0x${"ab".repeat(32)}`,
    auth: { nonce: "3", signature: `0x${"ab".repeat(65)}` },
    tuples: validTuples(),
    ...over,
  };
}

async function enroll(over: Partial<EstateEnrollPayload> = {}) {
  const payload = enrollPayload(over);
  return ownerCaller().estate.enroll({ payload, sig: await sign("estate.enroll", payload) });
}

async function seedClaimEmail(opts: { expired?: boolean; emailHash?: string } = {}) {
  const { token, tokenHash } = mintClaimToken();
  await db.insert(events).values({
    userId,
    type: ESTATE_EVENTS.claimEmailSent,
    payloadJson: {
      tokenHash,
      expiresAt: new Date(Date.now() + (opts.expired ? -1000 : 86_400_000)).toISOString(),
      ownerName: "Amaka",
      beneficiaryEmailHash: opts.emailHash ?? hashEmail("heir@example.com"),
      summary: { totalUsd: 4812, assetCount: 14, sourceCount: 5, perChain: [] },
    },
  });
  return { token, tokenHash };
}

async function cleanup() {
  // the heir row carries the REAL sha256 of the beneficiary email (the route
  // compares users.email_hash), so it needs its own cleanup target
  const stale = await db
    .select({ id: users.id })
    .from(users)
    .where(
      or(
        like(users.emailHash, "0xestate-route-test%"),
        eq(users.emailHash, hashEmail("heir@example.com")),
      ),
    );
  const ids = stale.map((r) => r.id);
  for (const id of ids) {
    await db.delete(estates).where(eq(estates.userId, id));
    await db.delete(plans).where(eq(plans.userId, id));
    await db.delete(events).where(eq(events.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
}

beforeEach(async () => {
  await cleanup();
  useRelay(stubRelay());
  estateLib.setEstateChainReaderFactory(() => ({
    accountNonce: async (chainId: number) => chainId === 42161 ? 7 : 0,
  }));
  const [owner] = await db
    .insert(users)
    .values({
      emailHash: EMAIL_HASH,
      eoaAddr: wallet.address,
      uaEvmAddr: wallet.address,
      uaSolAddr: "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",
      region: "DE",
    })
    .returning({ id: users.id });
  userId = owner!.id;
  const [heir] = await db
    .insert(users)
    .values({
      emailHash: hashEmail("heir@example.com"),
      eoaAddr: heirWallet.address,
      uaEvmAddr: heirWallet.address,
      uaSolAddr: "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",
      region: "",
    })
    .returning({ id: users.id });
  heirUserId = heir!.id;
});

afterAll(async () => {
  resetPlanRelayFactory();
  estateLib.resetEstateChainReaderFactory();
  await cleanup();
});

// ---------------------------------------------------------------------------
// prepareEnroll
// ---------------------------------------------------------------------------
describe("estate.prepareEnroll", () => {
  it("returns 5 ceremony targets (env delegates + live nonces) and the relay domain", async () => {
    const prep = await ownerCaller().estate.prepareEnroll();
    expect(prep.targets).toHaveLength(5);
    const arb = prep.targets.find((t) => t.chainId === 42161)!;
    expect(arb.delegateAddress).toBe(ARB_DELEGATE);
    expect(arb.nonce).toBe(7);
    expect(prep.authNonce).toBe("3");
    expect(prep.demoMode).toBe(true); // webTestEnv DEMO_MODE=1
    expect(prep.demoInactivitySecs).toBe(120);
    expect(prep.prefill).toBeNull();
  });

  it("prefills from a stashed legacy card (module 10 deviation 9)", async () => {
    await db.insert(plans).values({
      userId,
      kind: "legacy",
      paramsJson: { beneficiaryEmail: "sis@example.com", inactivityDays: 240 },
      contractPlanId: null,
      status: "draft",
    });
    const prep = await ownerCaller().estate.prepareEnroll();
    expect(prep.prefill).toEqual({ beneficiaryEmail: "sis@example.com", inactivityDays: 240 });
  });
});

// ---------------------------------------------------------------------------
// enroll
// ---------------------------------------------------------------------------
describe("estate.enroll", () => {
  it("relays the demo-substituted params and escrows decryptable secrets", async () => {
    const res = await enroll();
    expect(res.txHash).toBe("0xenrolltx");

    // relay saw keccak(email‖salt) + DEMO seconds (TS-9.5: substitution at
    // enrollment time; webTestEnv is DEMO_MODE=1)
    const relay = currentRelay();
    expect(relay.calls.enroll).toHaveLength(1);
    expect(relay.calls.enroll[0]!.beneficiaryHash).toBe(
      beneficiaryHashFor("heir@example.com", `0x${"ab".repeat(32)}`),
    );
    expect(relay.calls.enroll[0]!.inactivitySecs).toBe(120n);

    // the estates row holds REAL envelopes — decrypt and assert
    const [row] = await db.select().from(estates).where(eq(estates.userId, userId));
    const provider = devEscrowProvider("test-escrow-secret");
    const secret = JSON.parse(
      (
        await decryptEnvelope(
          provider,
          { owner: wallet.address, purpose: "estate-beneficiary" },
          row!.beneficiaryEmailEnc,
        )
      ).toString("utf8"),
    );
    expect(secret).toEqual({
      email: "heir@example.com",
      salt: `0x${"ab".repeat(32)}`,
      ownerName: "Amaka",
    });
    const tuples = JSON.parse(
      (
        await decryptEnvelope(
          provider,
          { owner: wallet.address, purpose: "estate-tuples" },
          row!.tuplesEnc!,
        )
      ).toString("utf8"),
    );
    expect(tuples).toHaveLength(5);
    expect(row!.refreshedAt).not.toBeNull();

    // the enrolled event carries the receipt + the sha256 email hash
    const rows = await db
      .select({ payload: events.payloadJson })
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.type, ESTATE_EVENTS.enrolled)));
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.receipt).toBe(
      "Inheritance plan set — your everyday activity keeps it current.",
    );
    expect(payload.beneficiaryEmailHash).toBe(hashEmail("heir@example.com"));
    expect(payload.demoScaled).toBe(true);
  });

  it("scrubs the module-10 legacy card's plaintext email (doc 14 'never')", async () => {
    const [legacy] = await db
      .insert(plans)
      .values({
        userId,
        kind: "legacy",
        paramsJson: {
          beneficiaryEmail: "heir@example.com",
          inactivityDays: 180,
          enrollEstateAuth: { nonce: "1", signature: `0x${"cd".repeat(65)}` },
        },
        contractPlanId: null,
        status: "draft",
      })
      .returning({ id: plans.id });
    await enroll();
    const [row] = await db
      .select({ params: plans.paramsJson })
      .from(plans)
      .where(eq(plans.id, legacy!.id));
    const params = row!.params as Record<string, unknown>;
    expect(params.beneficiaryEmail).toBe("h•••@example.com");
    expect(params.enrollEstateAuth).toBeNull();
  });

  it("rejects tuples that do not target the recorded delegate — nothing written", async () => {
    await expect(
      enroll({ tuples: tuplesFor({ 42161: `0x${"99".repeat(20)}` }) }),
    ).rejects.toThrow(/does not match the recorded coverage/);
    const rows = await db.select().from(estates).where(eq(estates.userId, userId));
    expect(rows).toHaveLength(0);
    expect(currentRelay().calls.enroll).toHaveLength(0);
  });

  it("a relay failure leaves nothing enrolled (chain is the authority)", async () => {
    useRelay(stubRelay({
        enrollEstate: async () => {
          throw new Error("BadNonce");
        },
      }));
    await expect(enroll()).rejects.toThrow(/nothing was changed/);
    const rows = await db.select().from(estates).where(eq(estates.userId, userId));
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// refreshTuples
// ---------------------------------------------------------------------------
describe("estate.refreshTuples", () => {
  it("replaces the escrowed set and bumps refreshed_at; refuses when not enrolled", async () => {
    await expect(
      ownerCaller().estate.refreshTuples({ tuples: validTuples() }),
    ).rejects.toThrow(/no inheritance plan/);

    await enroll();
    const [before] = await db.select().from(estates).where(eq(estates.userId, userId));
    await new Promise((r) => setTimeout(r, 5));
    await ownerCaller().estate.refreshTuples({ tuples: validTuples() });
    const [after] = await db.select().from(estates).where(eq(estates.userId, userId));
    expect(after!.tuplesEnc).not.toBe(before!.tuplesEnc); // fresh DEK/IV per write
    expect(after!.refreshedAt!.getTime()).toBeGreaterThanOrEqual(
      before!.refreshedAt!.getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// checkIn
// ---------------------------------------------------------------------------
describe("estate.checkIn", () => {
  async function checkIn() {
    const payload = { source: "im-here" as const };
    return ownerCaller().estate.checkIn({
      payload,
      sig: await sign("estate.checkIn", payload),
    });
  }

  it("relays and stores the CONFLICTS #13 proof on the event", async () => {
    const res = await checkIn();
    expect(res.cancelledCountdown).toBe(false);
    expect(currentRelay().calls.checkIn).toBe(1);
    const rows = await db
      .select({ payload: events.payloadJson })
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.type, ESTATE_EVENTS.checkin)));
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.receipt).toBe("Checked in — you pressed “I’m here”.");
    expect((payload.proof as { signature?: string }).signature).toMatch(/^0x/);
  });

  it("mid-countdown the same tap cancels — PS-F7-AC2's sentence, verbatim", async () => {
    useRelay(stubRelay({
        estateOf: async () => ({
          beneficiaryHash: `0x${"ab".repeat(32)}`,
          inactivitySecs: 120n,
          lastCheckIn: 0n,
          claimReadyAt: BigInt(Math.floor(Date.now() / 1000) + 30),
          status: 2,
        }),
      }));
    const res = await checkIn();
    expect(res.cancelledCountdown).toBe(true);
    const rows = await db
      .select({ payload: events.payloadJson })
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.type, ESTATE_EVENTS.checkin)));
    expect((rows[0]!.payload as { receipt: string }).receipt).toBe(
      "Welcome back. The countdown is cancelled.",
    );
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
describe("estate.status", () => {
  it("not enrolled → {enrolled:false}; enrolled → the chain view + cache", async () => {
    expect(await ownerCaller().estate.status()).toEqual({ enrolled: false, view: null });
    await enroll();
    const res = await ownerCaller().estate.status();
    expect(res.enrolled).toBe(true);
    expect(res.view!.status).toBe("enrolled");
    expect(res.view!.demoScaled).toBe(true);
    expect(res.view!.deadlineAt).not.toBeNull();
  });

  it("serves the cached view when the chain read fails (C8 never blanks)", async () => {
    await enroll();
    await ownerCaller().estate.status(); // warm the cache from the stub chain
    useRelay(stubRelay({
        estateOf: async () => {
          throw new Error("rpc down");
        },
      }));
    const res = await ownerCaller().estate.status();
    expect(res.enrolled).toBe(true);
    expect(res.view!.status).toBe("enrolled");
  });
});

// ---------------------------------------------------------------------------
// claimInfo / claimStart / claimStatus
// ---------------------------------------------------------------------------
describe("heir claim gate", () => {
  it("claimInfo: invalid token → NOT_FOUND; ready/expired/used states", async () => {
    await expect(anonCaller().estate.claimInfo({ token: "nope" })).rejects.toThrow(
      /isn't valid/,
    );

    const { token } = await seedClaimEmail();
    const info = await anonCaller().estate.claimInfo({ token });
    expect(info).toEqual({
      state: "ready",
      ownerName: "Amaka",
      summary: { totalUsd: 4812, assetCount: 14, sourceCount: 5, perChain: [] },
    });

    const { token: expired } = await seedClaimEmail({ expired: true });
    expect((await anonCaller().estate.claimInfo({ token: expired })).state).toBe("expired");
  });

  it("claimStart: needs a session, on the RIGHT email, once", async () => {
    const { token, tokenHash } = await seedClaimEmail();

    await expect(anonCaller().estate.claimStart({ token })).rejects.toThrow(
      /confirm your email/,
    );

    // owner's session email ≠ beneficiary email → refused
    await expect(ownerCaller().estate.claimStart({ token })).rejects.toThrow(
      /different email address/,
    );

    const res = await heirCaller().estate.claimStart({ token });
    expect(res.ok).toBe(true);
    const started = await db
      .select({ payload: events.payloadJson })
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.type, ESTATE_EVENTS.claimStarted)));
    expect(started).toHaveLength(1);
    expect((started[0]!.payload as { heirEoa: string }).heirEoa).toBe(heirWallet.address);
    const requested = await db
      .select({ payload: events.payloadJson })
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.type, ESTATE_EVENTS.claimRequested)));
    expect(requested).toHaveLength(1);
    expect((requested[0]!.payload as { tokenHash: string }).tokenHash).toBe(tokenHash);

    // single-use
    await expect(heirCaller().estate.claimStart({ token })).rejects.toThrow(
      /already started/,
    );
  });

  it("claimStart: expired token refused", async () => {
    const { token } = await seedClaimEmail({ expired: true });
    await expect(heirCaller().estate.claimStart({ token })).rejects.toThrow(/expired/);
  });

  it("claimStatus: keeper progress renders newest-per-chain; claimed → done", async () => {
    const { token } = await seedClaimEmail();
    await heirCaller().estate.claimStart({ token });

    // separate inserts — the keeper writes progress rows one statement at a
    // time, so each carries its own now() (batch rows would share a
    // timestamp and make "newest" unstable — module 11's µs lesson)
    for (const payloadJson of [
      { chainId: 8453, network: "Base", state: "delegated" },
      { chainId: 8453, network: "Base", state: "claimed" },
      { chainId: 42161, network: "Arbitrum", state: "stale-tuple" },
    ]) {
      await db.insert(events).values({
        userId,
        type: ESTATE_EVENTS.claimProgress,
        payloadJson,
      });
    }
    let status = await anonCaller().estate.claimStatus({ token });
    expect(status.started).toBe(true);
    expect(status.done).toBe(false);
    expect(status.sources).toEqual([
      { chainId: 8453, network: "Base", state: "claimed" },
      { chainId: 42161, network: "Arbitrum", state: "stale-tuple" },
    ]);

    await db.insert(events).values({
      userId,
      type: ESTATE_EVENTS.claimed,
      payloadJson: { receipt: "x", sourceCount: 2 },
    });
    status = await anonCaller().estate.claimStatus({ token });
    expect(status.done).toBe(true);
    expect(status.receipt).toContain("from 2 sources.");
  });
});

