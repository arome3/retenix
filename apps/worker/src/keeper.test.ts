import { estates, events, getDb, users } from "@retenix/db";
import {
  ESTATE_EVENTS,
  beneficiaryHashFor,
  type ClaimChainProgress,
} from "@retenix/shared";
import { devEscrowProvider, encryptEnvelope } from "@retenix/shared/escrow";
import { and, eq, like } from "drizzle-orm";
import { Wallet } from "ethers";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClaimChainIo } from "./estate-claim";
import type { EstateScanDeps } from "./estate-scan";
import type { EstateChainState, EstateOnchain } from "./estate-support";
import { keeperTick, type KeeperDeps } from "./keeper";

/*
 * Keeper over a real Postgres with REAL envelope crypto (the dev escrow
 * provider) and faked chain/scan edges: deadline belt, claim email minting
 * (token hash + summary + the revealed-match refusal), and the claim
 * sequence orchestration (markClaimed commit point, per-chain progress
 * events, idempotent re-runs, the hijack invariant).
 */

const db = getDb();
const PREFIX = "0xkeeper-test";
const OWNER = Wallet.createRandom().address;
const HEIR = "0x609D371A1615d2253E862eB4D95bB3B97323c05E";
const SALT = `0x${"ab".repeat(32)}`;
const EMAIL = "heir@example.com";
const GOOD_HASH = beneficiaryHashFor(EMAIL, SALT);
const escrow = devEscrowProvider("test-escrow-secret");

let userId: string;

const nowSecs = () => Math.floor(Date.now() / 1000);

function chainState(over: Partial<EstateChainState> = {}): EstateChainState {
  return {
    beneficiaryHash: GOOD_HASH,
    inactivitySecs: 120n,
    lastCheckIn: BigInt(nowSecs() - 30),
    claimReadyAt: 0n,
    status: 1,
    ...over,
  };
}

function fakeOnchain(over: Partial<EstateOnchain> = {}): EstateOnchain & {
  fired: string[];
  marked: { owner: string; heir: string }[];
} {
  const fired: string[] = [];
  const marked: { owner: string; heir: string }[] = [];
  const onchain: EstateOnchain = {
    estateOf: vi.fn(async () => chainState()),
    checkIn: vi.fn(async () => ({ txHash: "0xbump" })),
    fireDeadline: vi.fn(async (owner: string) => {
      fired.push(owner);
      return { txHash: "0xfire" };
    }),
    markClaimed: vi.fn(async (owner: string, heir: string) => {
      marked.push({ owner, heir });
      return { txHash: "0xmark" };
    }),
    claimedHeir: vi.fn(async () => null),
    ...over,
  };
  return Object.assign(onchain, { fired, marked });
}

const emptyScan: EstateScanDeps = {
  rpc: vi.fn(async (_url, method) => {
    if (method === "eth_getBalance") return "0x0";
    if (method === "alchemy_getTokenBalances") return { tokenBalances: [] };
    return {};
  }),
  prices: vi.fn(async () => new Map()),
};

/** Chain IO that claims cleanly on Arbitrum (the only non-zero delegate in
 *  the test env — the other four report skipped). */
function happyChainIo(): (chainId: number) => ClaimChainIo {
  return () => ({
    getCode: vi.fn(async () => `0xef0100${"92427d60cda5f63740d95ad972dfa5a115add8d0"}`),
    getTransactionCount: vi.fn(async () => 7),
    heirOf: vi.fn(async () => HEIR),
    sendApplyAndRegister: vi.fn(async () => ({ txHash: "0xapply", status: 1 })),
    sendRegister: vi.fn(async () => ({ txHash: "0xreg", status: 1 })),
    sendClaim: vi.fn(async () => ({
      txHash: "0xclaim",
      claimed: [{ token: "0x0000000000000000000000000000000000000000", amount: 5n }],
    })),
  });
}

function deps(over: Partial<KeeperDeps> = {}): KeeperDeps {
  return {
    db,
    onchain: fakeOnchain(),
    escrow,
    scan: emptyScan,
    chainIo: happyChainIo(),
    ...over,
  };
}

async function seedEstate(opts: { email?: string; salt?: string; tuples?: boolean } = {}) {
  const emailEnc = await encryptEnvelope(
    escrow,
    { owner: OWNER, purpose: "estate-beneficiary" },
    JSON.stringify({ email: opts.email ?? EMAIL, salt: opts.salt ?? SALT, ownerName: "Amaka" }),
  );
  const tuplesEnc = opts.tuples
    ? await encryptEnvelope(
        escrow,
        { owner: OWNER, purpose: "estate-tuples" },
        JSON.stringify([
          {
            chainId: 42161,
            address: "0x92427d60cda5f63740d95Ad972dFA5A115AdD8d0",
            nonce: 7,
            yParity: 0,
            r: `0x${"11".repeat(32)}`,
            s: `0x${"22".repeat(32)}`,
          },
        ]),
      )
    : null;
  await db.insert(estates).values({
    userId,
    beneficiaryEmailEnc: emailEnc,
    tuplesEnc,
    refreshedAt: new Date(),
    contractStateCache: { status: "enrolled", demoScaled: true },
  });
}

async function eventRows(type: string) {
  return db
    .select({ payload: events.payloadJson, at: events.createdAt })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.type, type)));
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
});

afterAll(cleanup);

describe("deadline belt (permissionless fireDeadline — pre-registration demo liveness)", () => {
  it("fires when the inactivity window lapsed; never when current", async () => {
    await seedEstate();
    const overdue = fakeOnchain({
      estateOf: vi.fn(async () =>
        chainState({ lastCheckIn: BigInt(nowSecs() - 200), inactivitySecs: 120n }),
      ),
    });
    await keeperTick(deps({ onchain: overdue }));
    // owner-scoped: parallel test files seed their own estates in this DB
    expect(overdue.fired).toContain(OWNER);

    const current = fakeOnchain();
    await keeperTick(deps({ onchain: current }));
    expect(current.fired).not.toContain(OWNER);
  });
});

describe("claim email", () => {
  it("Claimable → decrypt + revealed match + token hash + summary event; once per live token", async () => {
    await seedEstate();
    const onchain = fakeOnchain({
      estateOf: vi.fn(async () =>
        chainState({ status: 3, claimReadyAt: BigInt(nowSecs() - 5) }),
      ),
    });
    const d = deps({ onchain });
    await keeperTick(d);

    const sent = await eventRows(ESTATE_EVENTS.claimEmailSent);
    expect(sent).toHaveLength(1);
    const payload = sent[0]!.payload as Record<string, unknown>;
    expect(payload.tokenHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(payload.ownerName).toBe("Amaka");
    expect(payload.beneficiaryEmailHash).toMatch(/^0x/);
    expect(Date.parse(payload.expiresAt as string)).toBeGreaterThan(Date.now());
    const summary = payload.summary as { sourceCount: number; totalUsd: number };
    expect(summary.totalUsd).toBe(0); // empty scan fixture

    // second tick: the token is live — no second email
    await keeperTick(d);
    expect(await eventRows(ESTATE_EVENTS.claimEmailSent)).toHaveLength(1);
  });

  it("REFUSES to email when the decrypted secret doesn't match the onchain hash", async () => {
    await seedEstate({ email: "someone-else@example.com" });
    const onchain = fakeOnchain({
      estateOf: vi.fn(async () =>
        chainState({ status: 3, claimReadyAt: BigInt(nowSecs() - 5) }),
      ),
    });
    await keeperTick(deps({ onchain }));
    expect(await eventRows(ESTATE_EVENTS.claimEmailSent)).toHaveLength(0);
  });
});

describe("claim sequence", () => {
  async function requestClaim() {
    await db.insert(events).values({
      userId,
      type: ESTATE_EVENTS.claimRequested,
      payloadJson: { heirEoa: HEIR, heirUserId: "00000000-0000-0000-0000-000000000000" },
    });
  }

  it("markClaimed first, per-chain progress, honest aggregate (Arbitrum claimed, rest skipped)", async () => {
    await seedEstate({ tuples: true });
    await requestClaim();
    const onchain = fakeOnchain({
      estateOf: vi.fn(async () =>
        chainState({ status: 3, claimReadyAt: BigInt(nowSecs() - 5) }),
      ),
    });
    await keeperTick(deps({ onchain }));

    expect(onchain.marked).toEqual([{ owner: OWNER, heir: HEIR }]);
    const progress = (await eventRows(ESTATE_EVENTS.claimProgress)).map(
      (r) => r.payload as ClaimChainProgress,
    );
    expect(progress).toHaveLength(5);
    expect(progress.find((p) => p.chainId === 42161)?.state).toBe("claimed");
    expect(progress.filter((p) => p.state === "skipped")).toHaveLength(4);

    const done = await eventRows(ESTATE_EVENTS.claimed);
    expect(done).toHaveLength(1);
    const payload = done[0]!.payload as Record<string, unknown>;
    expect(payload.sourceCount).toBe(1);
    expect(payload.receipt).toContain("from 1 source.");
    expect(payload.heirEoa).toBe(HEIR);
  });

  it("re-runs are idempotent — a completed claim never runs again", async () => {
    await seedEstate({ tuples: true });
    await requestClaim();
    const onchain = fakeOnchain({
      estateOf: vi.fn(async () =>
        chainState({ status: 3, claimReadyAt: BigInt(nowSecs() - 5) }),
      ),
    });
    const d = deps({ onchain });
    await keeperTick(d);
    await keeperTick(d);
    expect(await eventRows(ESTATE_EVENTS.claimed)).toHaveLength(1);
    expect(onchain.marked).toHaveLength(1);
  });

  it("resume after markClaimed: Claimed status + matching committed heir proceeds", async () => {
    await seedEstate({ tuples: true });
    await requestClaim();
    const onchain = fakeOnchain({
      estateOf: vi.fn(async () => chainState({ status: 4 })),
      claimedHeir: vi.fn(async () => HEIR),
    });
    await keeperTick(deps({ onchain }));
    expect(onchain.marked).toHaveLength(0); // commit already landed
    expect(await eventRows(ESTATE_EVENTS.claimed)).toHaveLength(1);
  });

  it("resume with a DIFFERENT committed heir halts (support case)", async () => {
    await seedEstate({ tuples: true });
    await requestClaim();
    const onchain = fakeOnchain({
      estateOf: vi.fn(async () => chainState({ status: 4 })),
      claimedHeir: vi.fn(async () => "0x1111111111111111111111111111111111111111"),
    });
    await keeperTick(deps({ onchain }));
    expect(await eventRows(ESTATE_EVENTS.claimed)).toHaveLength(0);
  });

  it("a hijack path never survives an owner check-in — Enrolled means NOTHING moves", async () => {
    await seedEstate({ tuples: true });
    await requestClaim();
    const onchain = fakeOnchain(); // status enrolled — the owner came back
    await keeperTick(deps({ onchain }));
    expect(onchain.marked).toHaveLength(0);
    expect(await eventRows(ESTATE_EVENTS.claimProgress)).toHaveLength(0);
    expect(await eventRows(ESTATE_EVENTS.claimed)).toHaveLength(0);
  });
});
