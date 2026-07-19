import { keccak256, toUtf8Bytes } from "ethers";
import { describe, expect, it } from "vitest";
import {
  CLAIM_TOKEN_TTL_MS,
  ESTATE_EVENTS,
  beneficiaryHashFor,
  claimTokenHash,
  escrowTupleSchema,
  escrowTupleSetSchema,
  estateCheckInPayloadSchema,
  estateEnrollPayloadSchema,
  estateStatusName,
  mintClaimToken,
  normalizeBeneficiaryEmail,
  resolveInactivitySecs,
} from "./estate";
import { ESTATE_CHAIN_IDS } from "./contracts";
import {
  estateCheckinButtonReceipt,
  estateCheckinObservedReceipt,
  estateClaimedReceipt,
} from "./receipts";
import { FEED_EVENT_TYPES } from "./feed";

const SALT = `0x${"ab".repeat(32)}`;
const R = `0x${"11".repeat(32)}`;
const S = `0x${"22".repeat(32)}`;

function tupleFor(chainId: number) {
  return {
    chainId,
    address: "0x92427d60cda5f63740d95Ad972dFA5A115AdD8d0",
    nonce: 0,
    yParity: 0 as const,
    r: R,
    s: S,
  };
}

function fullSet() {
  return ESTATE_CHAIN_IDS.map((id) => tupleFor(id));
}

describe("escrowed tuples", () => {
  it("accepts a well-formed tuple and rejects chainId 0 (cross-chain replay)", () => {
    expect(escrowTupleSchema.safeParse(tupleFor(8453)).success).toBe(true);
    expect(escrowTupleSchema.safeParse(tupleFor(0)).success).toBe(false);
  });

  it("the set must cover exactly the 5 estate networks", () => {
    expect(escrowTupleSetSchema.safeParse(fullSet()).success).toBe(true);
    expect(escrowTupleSetSchema.safeParse(fullSet().slice(1)).success).toBe(false);
    const wrongChain = [...fullSet().slice(1), tupleFor(101)]; // Solana is never covered
    expect(escrowTupleSetSchema.safeParse(wrongChain).success).toBe(false);
    const duplicated = [...fullSet().slice(1), tupleFor(8453)];
    expect(escrowTupleSetSchema.safeParse(duplicated).success).toBe(false);
  });
});

describe("beneficiary hash (keccak(email‖salt), PROPOSED preimage)", () => {
  it("normalizes case and whitespace before hashing", () => {
    expect(normalizeBeneficiaryEmail("  Heir@Example.COM ")).toBe("heir@example.com");
    expect(beneficiaryHashFor("  Heir@Example.COM ", SALT)).toBe(
      beneficiaryHashFor("heir@example.com", SALT),
    );
  });

  it("salt changes the hash (email alone is never brute-forceable onchain)", () => {
    const a = beneficiaryHashFor("heir@example.com", SALT);
    const b = beneficiaryHashFor("heir@example.com", `0x${"cd".repeat(32)}`);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is NOT the bare email hash", () => {
    expect(beneficiaryHashFor("heir@example.com", SALT)).not.toBe(
      keccak256(toUtf8Bytes("heir@example.com")),
    );
  });
});

describe("claim token", () => {
  it("mints a 64-hex token whose sha256 matches claimTokenHash", () => {
    const { token, tokenHash } = mintClaimToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(claimTokenHash(token)).toBe(tokenHash);
    expect(tokenHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("tokens are unique per mint and the TTL is 7 days", () => {
    expect(mintClaimToken().token).not.toBe(mintClaimToken().token);
    expect(CLAIM_TOKEN_TTL_MS).toBe(604_800_000);
  });
});

describe("demo scaling (TS-9.5 — substitution at enrollment time only)", () => {
  it("prod: days convert to seconds; demo: the env value substitutes", () => {
    expect(resolveInactivitySecs(180, false, 120)).toEqual({
      inactivitySecs: 180 * 86_400,
      demoScaled: false,
    });
    expect(resolveInactivitySecs(180, true, 120)).toEqual({
      inactivitySecs: 120,
      demoScaled: true,
    });
  });
});

describe("payload schemas", () => {
  it("enroll payload validates and bounds the draft range", () => {
    const base = {
      beneficiaryEmail: "heir@example.com",
      inactivityDays: 180,
      salt: SALT,
      auth: { nonce: "0", signature: `0x${"ab".repeat(65)}` },
      tuples: fullSet(),
    };
    expect(estateEnrollPayloadSchema.safeParse(base).success).toBe(true);
    expect(estateEnrollPayloadSchema.safeParse({ ...base, inactivityDays: 29 }).success).toBe(false);
    expect(estateEnrollPayloadSchema.safeParse({ ...base, inactivityDays: 3651 }).success).toBe(false);
    expect(
      estateEnrollPayloadSchema.safeParse({ ...base, beneficiaryEmail: "not-an-email" }).success,
    ).toBe(false);
    expect(
      estateEnrollPayloadSchema.safeParse({ ...base, ownerDisplayName: "Amaka" }).success,
    ).toBe(true);
  });

  it("check-in payload is the minimal source marker", () => {
    expect(estateCheckInPayloadSchema.safeParse({ source: "im-here" }).success).toBe(true);
    expect(estateCheckInPayloadSchema.safeParse({ source: "other" }).success).toBe(false);
  });
});

describe("status + feed wiring", () => {
  it("maps the contract enum order (doc 07 pinned)", () => {
    expect(estateStatusName(0)).toBe("none");
    expect(estateStatusName(1)).toBe("enrolled");
    expect(estateStatusName(2)).toBe("countdown");
    expect(estateStatusName(3)).toBe("claimable");
    expect(estateStatusName(4)).toBe("claimed");
    expect(estateStatusName(5)).toBe("cancelled");
    expect(estateStatusName(99)).toBe("none");
  });

  it("feed-renderable estate events are allowlisted; audit events are NOT", () => {
    const feed = FEED_EVENT_TYPES as readonly string[];
    for (const t of [
      ESTATE_EVENTS.enrolled,
      ESTATE_EVENTS.checkin,
      ESTATE_EVENTS.countdownStarted,
      ESTATE_EVENTS.activityNoticed,
      ESTATE_EVENTS.claimed,
    ]) {
      expect(feed).toContain(t);
    }
    for (const t of [
      ESTATE_EVENTS.claimEmailSent,
      ESTATE_EVENTS.claimRequested,
      ESTATE_EVENTS.claimStarted,
      ESTATE_EVENTS.claimProgress,
    ]) {
      expect(feed).not.toContain(t);
    }
  });
});

describe("receipt copy (byte-pinned — PS-F7-AC2's cancel sentence is verbatim)", () => {
  it("cancel moment", () => {
    expect(estateCheckinButtonReceipt(true)).toBe("Welcome back. The countdown is cancelled.");
    expect(estateCheckinButtonReceipt(false)).toBe("Checked in — you pressed “I’m here”.");
  });

  it("observed check-in names where the activity happened", () => {
    expect(estateCheckinObservedReceipt("Base")).toBe(
      "Checked in — your activity on Base kept your inheritance plan current.",
    );
  });

  it("claimed receipt is grammatical at 1 source", () => {
    expect(estateClaimedReceipt(1)).toContain("from 1 source.");
    expect(estateClaimedReceipt(5)).toContain("from 5 sources.");
  });
});
