import { events, getDb, users } from "@retenix/db";
import { CHAIN_ID, SUPPORTED_TOKEN_TYPE, primaryTokenFor } from "@retenix/ua";
import { eq } from "drizzle-orm";
import { Wallet, parseUnits, zeroPadValue, getAddress } from "ethers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashEmail } from "@/lib/emailHash";
import {
  TRANSFER_TOPIC,
  computeUnits,
  isStable,
  primaryPriceAndBalance,
  resolveRecipient,
  verifyDelivery,
  withdrawToken,
} from "./send";

const db = getDb();
const EMAIL = "resolve-target@example.com";
const wallet = Wallet.createRandom();
let targetUserId: string;

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
      uaEvmAddr: wallet.address,
      uaSolAddr: "",
      region: "DE",
    })
    .returning({ id: users.id });
  targetUserId = row.id;
});
afterAll(cleanup);

// ---------------------------------------------------------------------------
// The resolution ladder (doc 15 DoD: registered / unregistered / ENS hit /
// ENS miss / bad checksum)
// ---------------------------------------------------------------------------

describe("resolveRecipient", () => {
  const noEns = { resolveEns: vi.fn().mockResolvedValue(null) };

  it("registered email → the recipient's EOA (≡ UA EVM address), masked display", async () => {
    const res = await resolveRecipient(
      db,
      { kind: "email", value: `  ${EMAIL.toUpperCase()}  ` },
      noEns,
    );
    expect(res).toEqual({
      kind: "registered",
      recipientUserId: targetUserId,
      address: wallet.address,
      display: "r•••@example.com",
    });
  });

  it("unregistered email → invite path marker, never an address", async () => {
    const res = await resolveRecipient(
      db,
      { kind: "email", value: "nobody-here@example.com" },
      noEns,
    );
    expect(res).toEqual({
      kind: "unregistered",
      email: "nobody-here@example.com",
      display: "n•••@example.com",
    });
  });

  it("malformed email → BAD_REQUEST", async () => {
    await expect(
      resolveRecipient(db, { kind: "email", value: "not-an-email" }, noEns),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("ENS hit → external with the resolved address, lowercased name display", async () => {
    const addr = getAddress("0x" + "ab".repeat(20));
    const res = await resolveRecipient(
      db,
      { kind: "ens", value: "Ana.eth" },
      { resolveEns: vi.fn().mockResolvedValue(addr) },
    );
    expect(res).toEqual({ kind: "external", address: addr, display: "ana.eth" });
  });

  it('ENS miss → BAD_REQUEST "name not found"', async () => {
    await expect(
      resolveRecipient(db, { kind: "ens", value: "nobody.eth" }, noEns),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "name not found" });
  });

  it("address → checksum-validated and canonicalized; bad checksum refused", async () => {
    const lower = wallet.address.toLowerCase();
    const res = await resolveRecipient(db, { kind: "address", value: lower }, noEns);
    expect(res).toMatchObject({ kind: "external", address: wallet.address });
    // display is truncated per DS-9.3
    expect((res as { display: string }).display).toBe(
      `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`,
    );

    // flip one character of a checksummed address → invalid
    const bad = wallet.address.slice(0, -1) + (wallet.address.endsWith("a") ? "b" : "a");
    await expect(
      resolveRecipient(db, { kind: "address", value: bad }, noEns),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("solana targets validate base58 instead of EVM checksum", async () => {
    const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const res = await resolveRecipient(db, { kind: "address", value: mint }, noEns, {
      solanaTarget: true,
    });
    expect(res).toMatchObject({ kind: "external", address: mint });
    await expect(
      resolveRecipient(db, { kind: "address", value: "0Ol1short" }, noEns, {
        solanaTarget: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ---------------------------------------------------------------------------
// Withdraw pair validation + units math
// ---------------------------------------------------------------------------

describe("withdrawToken", () => {
  it("valid pair → the token with ON-CHAIN decimals (realDecimals)", () => {
    const t = withdrawToken("usdc", CHAIN_ID.ARBITRUM_MAINNET_ONE);
    expect(t.symbol).toBe("USDC");
    expect(t.decimals).toBe(6); // never the SDK's 18-dp normalized figure
    expect(t.address).toBe(
      primaryTokenFor(SUPPORTED_TOKEN_TYPE.USDC, CHAIN_ID.ARBITRUM_MAINNET_ONE)!.address,
    );
  });
  it("invalid pairs and unknown assets are refused", () => {
    expect(() => withdrawToken("sol", CHAIN_ID.ARBITRUM_MAINNET_ONE)).toThrow(
      /can't arrive there/,
    );
    expect(() => withdrawToken("usdc", CHAIN_ID.XLAYER_MAINNET)).toThrow(
      /can't arrive there/,
    );
    expect(() => withdrawToken("doge", CHAIN_ID.BSC_MAINNET)).toThrow(/unknown asset/);
  });
});

describe("computeUnits", () => {
  it("stables move 1:1 ($2 → '2')", () => {
    expect(computeUnits(2, 1, 6)).toBe("2");
    expect(isStable("usdc")).toBe(true);
    expect(isStable("eth")).toBe(false);
  });
  it("floor-truncates to the token's decimals — never over-sends", () => {
    // $2 of SOL at $160 → 0.0125 exactly
    expect(computeUnits(2, 160, 9)).toBe("0.0125");
    // $10 of ETH at $3000 → 0.003333… truncated at 18dp, no rounding up
    const u = computeUnits(10, 3000, 18);
    expect(Number(u)).toBeLessThanOrEqual(10 / 3000);
    expect(u.startsWith("0.00333333")).toBe(true);
  });
  it("nonsense prices are refused", () => {
    expect(() => computeUnits(2, 0, 6)).toThrow();
    expect(() => computeUnits(2, -5, 6)).toThrow();
  });
});

describe("primaryPriceAndBalance", () => {
  it("reads the matching asset's price and USD balance", () => {
    const resp = {
      assets: [
        { tokenType: "sol", price: 160, amountInUSD: 42.5 },
        { tokenType: "usdc", price: 1, amountInUSD: 10 },
      ],
    };
    expect(primaryPriceAndBalance(resp, "sol")).toEqual({
      price: 160,
      amountInUSD: 42.5,
    });
  });
  it("absent asset / bad shapes degrade to null price + zero balance", () => {
    expect(primaryPriceAndBalance({}, "sol")).toEqual({ price: null, amountInUSD: 0 });
    expect(
      primaryPriceAndBalance({ assets: [{ tokenType: "sol", price: "x" }] }, "sol"),
    ).toEqual({ price: null, amountInUSD: 0 });
  });
});

// ---------------------------------------------------------------------------
// Delivery proof — the recipient's receipt gate
// ---------------------------------------------------------------------------

describe("verifyDelivery", () => {
  const recipient = wallet.address;
  const token = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  const args = {
    tokenAddress: token,
    tokenDecimals: 6,
    recipient,
    amountUnits: "2",
    fromBlock: 1000,
  };

  it("true when a Transfer(→recipient) of ≥98% of the units exists", async () => {
    const getLogs = vi
      .fn()
      .mockResolvedValue([{ data: "0x" + parseUnits("1.97", 6).toString(16) }, { data: "0x" + parseUnits("2", 6).toString(16) }]);
    expect(await verifyDelivery({ getLogs }, args)).toBe(true);
    expect(getLogs).toHaveBeenCalledWith({
      address: token,
      topics: [TRANSFER_TOPIC, null, zeroPadValue(recipient, 32)],
      fromBlock: 1000,
      toBlock: "latest",
    });
  });

  it("false when only smaller transfers exist", async () => {
    const getLogs = vi
      .fn()
      .mockResolvedValue([{ data: "0x" + parseUnits("1.9", 6).toString(16) }]);
    expect(await verifyDelivery({ getLogs }, args)).toBe(false);
  });

  it("false when no transfer exists; null when the scan itself fails", async () => {
    expect(
      await verifyDelivery({ getLogs: vi.fn().mockResolvedValue([]) }, args),
    ).toBe(false);
    expect(
      await verifyDelivery(
        { getLogs: vi.fn().mockRejectedValue(new Error("rpc")) },
        args,
      ),
    ).toBeNull();
  });
});
