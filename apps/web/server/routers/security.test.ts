import { events, getDb, plans, users } from "@retenix/db";
import {
  SECURITY_EVENTS,
  buildSignedMessage,
  computeInputHash,
  type SigEnvelope,
} from "@retenix/shared";
import { and, eq } from "drizzle-orm";
import { Wallet } from "ethers";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashEmail } from "@/lib/emailHash";
import type { Context } from "../context";
import type { PlanRelay } from "../lib/relay-factory";

/*
 * security.* routes over a real Postgres, relay mocked via the factory seam
 * (kill.test.ts conventions). The load-bearing claims: revoke-all flips
 * broker/guardian ONLY (legacy never), writes the per-plan dismissal
 * receipts + the audit row, verifies BEFORE relaying, relays BEFORE flipping
 * (a failed send changes nothing), and converges honestly when there is
 * nothing to dismiss.
 */

const { setPlanRelayFactory, resetPlanRelayFactory } = await import(
  "../lib/relay-factory"
);
const { delegationsCache } = await import("../lib/delegations");
const { appRouter } = await import("./index");

const db = getDb();
const wallet = Wallet.createRandom();
const EMAIL = "security-route-test@example.com";

let userId: string;

const ctx = (): Context => ({
  db,
  session: { userId, eoaAddr: wallet.address, issuer: "did:test", region: "DE" },
  headers: new Headers(),
  resHeaders: new Headers(),
});
const caller = () => appRouter.createCaller(ctx());

let nonceCounter = Date.now();
async function sign(payload: unknown): Promise<SigEnvelope> {
  const nonce = ++nonceCounter;
  const expiry = Math.floor(Date.now() / 1000) + 240;
  const message = buildSignedMessage({
    route: "security.revokeAll",
    inputHash: computeInputHash(payload),
    nonce,
    expiry,
  });
  return { signature: await wallet.signMessage(message), nonce, expiry };
}

async function revokeAll(payload: { nonce: string; signature: string }) {
  return caller().security.revokeAll({ payload, sig: await sign(payload) });
}

function stubRelay(over: Partial<PlanRelay> = {}): { relay: PlanRelay; calls: string[] } {
  const calls: string[] = [];
  const relay: PlanRelay = {
    domain: { chainId: 421614, contract: "0x4549a91b4727537372925C8C589d9BCfF9B6c261" },
    authNonce: async () => {
      calls.push("authNonce");
      return 7n;
    },
    agentAddress: async () => "0x562937835cdD5C92F54B94Df658Fd3b50A68ecD5",
    buildCreatePlanDigest: async () => `0x${"cd".repeat(32)}`,
    createPlan: async () => ({ txHash: "0xtx", planId: 42n }),
    revokePlanFor: async () => ({ txHash: "0xrevoke" }),
    verifyRevokeAll: () => {
      calls.push("verifyRevokeAll");
      return true;
    },
    revokeAll: async () => {
      calls.push("revokeAll");
      return { txHash: "0xrevokeall" };
    },
    txStatus: async () => {
      calls.push("txStatus");
      return "confirmed" as const;
    },
    enrollEstate: async () => ({ txHash: "0xenroll" }),
    checkIn: async () => ({ txHash: "0xcheckin" }),
    estateOf: async () => ({
      beneficiaryHash: `0x${"00".repeat(32)}`,
      inactivitySecs: 0n,
      lastCheckIn: 0n,
      claimReadyAt: 0n,
      status: 0,
    }),
    ...over,
  };
  return { relay, calls };
}

async function seedPlans() {
  return db
    .insert(plans)
    .values([
      { userId, kind: "broker", paramsJson: {}, contractPlanId: 42, status: "active" },
      { userId, kind: "guardian", paramsJson: {}, contractPlanId: 42, status: "paused" },
      { userId, kind: "legacy", paramsJson: {}, contractPlanId: null, status: "active" },
    ])
    .returning({ id: plans.id, kind: plans.kind });
}

async function planStatuses(): Promise<Record<string, string>> {
  const rows = await db
    .select({ kind: plans.kind, status: plans.status })
    .from(plans)
    .where(eq(plans.userId, userId));
  return Object.fromEntries(rows.map((r) => [r.kind, r.status]));
}

async function wipe() {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.emailHash, hashEmail(EMAIL)));
  for (const row of rows) {
    await db.delete(events).where(eq(events.userId, row.id));
    await db.delete(plans).where(eq(plans.userId, row.id));
    await db.delete(users).where(eq(users.id, row.id));
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  delegationsCache.clear();
  await wipe();
  const [row] = await db
    .insert(users)
    .values({
      emailHash: hashEmail(EMAIL),
      eoaAddr: wallet.address,
      uaEvmAddr: wallet.address,
      uaSolAddr: "",
      region: "DE",
    })
    .returning({ id: users.id });
  userId = row.id;
});
afterEach(() => resetPlanRelayFactory());
afterAll(wipe);

describe("security.prepareRevokeAll", () => {
  it("live plans → digest + nonce + the revocable roster (legacy excluded)", async () => {
    await seedPlans();
    const { relay } = stubRelay();
    setPlanRelayFactory(() => relay);

    const res = await caller().security.prepareRevokeAll();
    expect(res.needsRevoke).toBe(true);
    expect(res.nonce).toBe("7");
    expect(res.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.revocable.map((p) => p.kind).sort()).toEqual(["broker", "guardian"]);
  });

  it("no live plans → nothing to sign", async () => {
    const res = await caller().security.prepareRevokeAll();
    expect(res).toMatchObject({ needsRevoke: false, digest: null, nonce: null });
    expect(res.revocable).toEqual([]);
  });
});

describe("security.revokeAll", () => {
  it("flips broker/guardian, writes receipts + audit row, LEGACY NEVER", async () => {
    await seedPlans();
    const { relay, calls } = stubRelay();
    setPlanRelayFactory(() => relay);

    const res = await revokeAll({ nonce: "7", signature: `0x${"ab".repeat(65)}` });
    expect(res).toEqual({ state: "confirmed", dismissed: 2, txHash: "0xrevokeall" });

    expect(await planStatuses()).toEqual({
      broker: "revoked",
      guardian: "revoked",
      legacy: "active", // test-pinned: revoke-all NEVER touches the estate
    });

    const dismissals = await db
      .select({ payloadJson: events.payloadJson })
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.type, "plan.revoked")));
    expect(dismissals).toHaveLength(2);
    for (const d of dismissals) {
      expect((d.payloadJson as { receipt: string }).receipt).toMatch(/dismissed/);
    }
    const audit = await db
      .select({ payloadJson: events.payloadJson })
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.type, SECURITY_EVENTS.revokeAll)));
    expect(audit).toHaveLength(1);
    expect(audit[0].payloadJson).toMatchObject({ txHash: "0xrevokeall", nonce: "7" });

    // verify BEFORE relay (never spend relayer gas on a known BadSignature)
    expect(calls.indexOf("verifyRevokeAll")).toBeLessThan(calls.indexOf("revokeAll"));
  });

  it("stale nonce → re-prepare, nothing changed", async () => {
    await seedPlans();
    const { relay } = stubRelay();
    setPlanRelayFactory(() => relay);
    await expect(
      revokeAll({ nonce: "6", signature: `0x${"ab".repeat(65)}` }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /re-prepare/ });
    expect((await planStatuses()).broker).toBe("active");
  });

  it("signature mismatch → refused before any write or relay", async () => {
    await seedPlans();
    const { relay, calls } = stubRelay({ verifyRevokeAll: () => false });
    setPlanRelayFactory(() => relay);
    await expect(
      revokeAll({ nonce: "7", signature: `0x${"ab".repeat(65)}` }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /does not match/ });
    expect(calls).not.toContain("revokeAll");
    expect((await planStatuses()).broker).toBe("active");
  });

  it("relay send failure → NOTHING changes (relay-first ordering)", async () => {
    await seedPlans();
    const { relay } = stubRelay({
      revokeAll: async () => {
        throw new Error("rpc down");
      },
    });
    setPlanRelayFactory(() => relay);
    await expect(
      revokeAll({ nonce: "7", signature: `0x${"ab".repeat(65)}` }),
    ).rejects.toMatchObject({ message: /nothing was changed/ });
    expect((await planStatuses()).broker).toBe("active");
    const audit = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.type, SECURITY_EVENTS.revokeAll)));
    expect(audit).toHaveLength(0);
  });

  it("nothing to dismiss (incl. an idempotent second call) → honest no-op", async () => {
    const { relay, calls } = stubRelay();
    setPlanRelayFactory(() => relay);
    const first = await revokeAll({ nonce: "7", signature: `0x${"ab".repeat(65)}` });
    expect(first).toEqual({ state: "nothing", dismissed: 0, txHash: null });
    expect(calls).not.toContain("revokeAll");

    await seedPlans();
    await revokeAll({ nonce: "7", signature: `0x${"ab".repeat(65)}` });
    const again = await revokeAll({ nonce: "7", signature: `0x${"ab".repeat(65)}` });
    expect(again.state).toBe("nothing");
  });

  // the in-request confirmation poll runs ~7.5s when the tx stays pending
  it("a pending confirmation is reported as submitted, and revokeStatus reads it lazily", { timeout: 15_000 }, async () => {
    await seedPlans();
    let status: "pending" | "confirmed" = "pending";
    const { relay } = stubRelay({ txStatus: async () => status });
    setPlanRelayFactory(() => relay);

    const res = await revokeAll({ nonce: "7", signature: `0x${"ab".repeat(65)}` });
    expect(res.state).toBe("submitted");

    status = "confirmed";
    const read = await caller().security.revokeStatus();
    expect(read).toEqual({ state: "confirmed", txHash: "0xrevokeall" });
  });
});
