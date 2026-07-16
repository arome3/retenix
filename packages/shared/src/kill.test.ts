// Module 13 — the shared kill contract. The cross-contract pins here are the
// load-bearing ones: kill.leg payloads feed the portfolio basis ledger
// (portfolio-fills.ts) and the feed (feed.ts) simultaneously, and both
// consumers have silent-corruption failure modes if the shapes drift.
import { describe, expect, it } from "vitest";
import {
  KILL_EVENTS,
  KILL_LEG_STATES,
  KILL_TERMINAL_STATES,
  KILL_RETRYABLE_STATES,
  KILL_HOLD_MS,
  KILL_CONVERT_HAIRCUT,
  KILL_CONVERT_FLOOR_USD,
  isKillTerminal,
  killLegPayloadSchema,
  killStartedPayloadSchema,
  killExecutePayloadSchema,
  killReportLegPayloadSchema,
  type KillLegPayload,
  type KillLegState,
} from "./kill";
import {
  killLegSoldReceipt,
  killLegConvertedReceipt,
  killLegFailedReceipt,
  killLegUnverifiedReceipt,
  killReceiptText,
  refundedReceipt,
} from "./receipts";
import {
  sellCompleted,
  sellFillFromEvent,
  collectFills,
} from "./portfolio-fills";
import { buildBasisLedger } from "./portfolio";

const legPayload = (over: Partial<KillLegPayload> = {}): KillLegPayload => ({
  killId: "k-1",
  legId: "l-1",
  kind: "sell",
  assetId: "spyx",
  symbol: "SPYx",
  chainId: 101,
  network: "Solana",
  token: "XsDoVfqeBukxuZHWhdvWHBhgEWjGNVXXZZDoDUP4hfrr",
  amountHuman: "0.05",
  usdEst: 32.5,
  outcome: "pending",
  attempt: 1,
  ...over,
});

// ---------------------------------------------------------------------------
// Cross-contract: kill.leg × the portfolio basis ledger (a.2 traps)
// ---------------------------------------------------------------------------

describe("kill.leg × sellFillFromEvent (basis-ledger contract)", () => {
  it("only 'settled' counts as a completed sell among all six leg states", () => {
    const completed = KILL_LEG_STATES.filter((s) => sellCompleted(s));
    expect(completed).toEqual(["settled"]);
  });

  it("guards the absent-outcome trap: sellCompleted(undefined) is true, so every payload MUST carry outcome from birth", () => {
    // This is WHY killLegPayloadSchema requires `outcome` — an absent outcome
    // on an events row would count as a completed sell.
    expect(sellCompleted(undefined)).toBe(true);
    expect(killLegPayloadSchema.safeParse({ ...legPayload(), outcome: undefined }).success).toBe(
      false,
    );
  });

  it("a pending leg maps to {skipped}, never {unattributed}", () => {
    const mapping = sellFillFromEvent({
      payloadJson: legPayload({ outcome: "pending" }),
      atIso: "2026-07-16T12:00:00.000Z",
    });
    expect(mapping).toEqual({ skipped: true });
  });

  it("a submitted leg is also skipped (in-flight, moved nothing yet)", () => {
    const mapping = sellFillFromEvent({
      payloadJson: legPayload({ outcome: "submitted", transactionId: "tx_abc12345" }),
      atIso: "2026-07-16T12:00:00.000Z",
    });
    expect(mapping).toEqual({ skipped: true });
  });

  it("a settled leg maps to a valid sell fill with the server's own qty/usd", () => {
    const mapping = sellFillFromEvent({
      payloadJson: legPayload({ outcome: "settled", qty: 0.05, usd: 32.11 }),
      atIso: "2026-07-16T12:00:00.000Z",
    });
    expect(mapping).toEqual({
      fill: {
        side: "sell",
        assetId: "spyx",
        usd: 32.11,
        qty: 0.05,
        at: "2026-07-16T12:00:00.000Z",
      },
    });
  });

  it("failed/refunded/unverified legs are skipped — the position is still held", () => {
    for (const outcome of KILL_RETRYABLE_STATES) {
      const mapping = sellFillFromEvent({
        payloadJson: legPayload({ outcome }),
        atIso: "2026-07-16T12:00:00.000Z",
      });
      expect(mapping, outcome).toEqual({ skipped: true });
    }
  });

  it("a settled convert for a never-bought primary (bnb) degrades per-asset, never globally", () => {
    const mapping = sellFillFromEvent({
      payloadJson: legPayload({
        kind: "convert",
        assetId: "bnb",
        symbol: "BNB",
        outcome: "settled",
        qty: 0.02,
        usd: 12.4,
      }),
      atIso: "2026-07-16T12:00:00.000Z",
    });
    expect("fill" in mapping).toBe(true);
    const { fills, unattributed } = collectFills([mapping]);
    expect(unattributed).toBe(0); // assetId present → NEVER global basis poison
    const ledger = buildBasisLedger(fills);
    // A sell of an asset with no prior buys marks THAT asset's basis unknown.
    expect(ledger.get("bnb")?.basisKnown).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// State machine invariants
// ---------------------------------------------------------------------------

describe("leg state machine", () => {
  it("terminal ∪ in-flight covers all states exactly once", () => {
    const inFlight = KILL_LEG_STATES.filter((s) => !isKillTerminal(s));
    expect(inFlight).toEqual(["pending", "submitted"]);
    expect(KILL_TERMINAL_STATES.length + inFlight.length).toBe(KILL_LEG_STATES.length);
  });

  it("settled is terminal but never retryable; retryable ⊂ terminal", () => {
    expect(isKillTerminal("settled")).toBe(true);
    expect(KILL_RETRYABLE_STATES).not.toContain("settled");
    for (const s of KILL_RETRYABLE_STATES) expect(isKillTerminal(s)).toBe(true);
  });

  it("constants: 1.5s hold (C7 verbatim), haircut and floor pinned", () => {
    expect(KILL_HOLD_MS).toBe(1500);
    expect(KILL_CONVERT_HAIRCUT).toBe(0.98);
    expect(KILL_CONVERT_FLOOR_USD).toBe(0.5);
  });

  it("event type strings match the doc-13 set", () => {
    expect(KILL_EVENTS).toEqual({
      started: "kill.started",
      leg: "kill.leg",
      receipt: "kill.receipt",
    });
  });
});

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

describe("wire schemas", () => {
  it("execute payload: revokeAllAuth nonce is a decimal string (no-transformer bigint law)", () => {
    expect(
      killExecutePayloadSchema.safeParse({
        revokeAllAuth: { nonce: "3", signature: "0xabc" },
        tapAtMs: 1_752_600_000_000,
        holdCompletedAtMs: 1_752_600_002_000,
      }).success,
    ).toBe(true);
    expect(
      killExecutePayloadSchema.safeParse({
        revokeAllAuth: { nonce: "0x3", signature: "0xabc" },
      }).success,
    ).toBe(false);
    // Zero-plan kills carry no auth at all.
    expect(killExecutePayloadSchema.safeParse({}).success).toBe(true);
  });

  it("reportLeg payload: phases and uuid ids enforced", () => {
    const base = {
      killId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      legId: "7f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    };
    expect(
      killReportLegPayloadSchema.safeParse({
        ...base,
        phase: "submitted",
        transactionId: "tx_abc12345",
      }).success,
    ).toBe(true);
    expect(
      killReportLegPayloadSchema.safeParse({ ...base, phase: "exploded" }).success,
    ).toBe(false);
    expect(
      killReportLegPayloadSchema.safeParse({
        killId: "not-a-uuid",
        legId: base.legId,
        phase: "terminal",
      }).success,
    ).toBe(false);
  });

  it("leg payload round-trips through its schema; unknown keys survive (loose)", () => {
    const parsed = killLegPayloadSchema.parse({
      ...legPayload(),
      futureField: "kept",
    });
    expect(parsed.outcome).toBe("pending");
    expect((parsed as Record<string, unknown>).futureField).toBe("kept");
  });

  it("started payload defaults reconstruct from a minimal crash-era row", () => {
    const parsed = killStartedPayloadSchema.parse({
      killId: "k-1",
      executeReceivedAtMs: 1,
      revoke: { state: "submitted", txHash: "0xdead" },
    });
    expect(parsed.planIds).toEqual([]);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.legCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Receipt templates (byte-pinned — golden convention of receipts.test.ts)
// ---------------------------------------------------------------------------

describe("kill receipt templates (byte-exact)", () => {
  it("per-leg settled sell / convert (number-free, module-12 sell.receipt register)", () => {
    expect(killLegSoldReceipt("SPYx")).toBe("Sold SPYx — now USDC in your balance.");
    expect(killLegConvertedReceipt("ETH")).toBe("Converted ETH to USDC in your balance.");
  });

  it("per-leg failed / unverified", () => {
    expect(killLegFailedReceipt("TSLAx")).toBe("Couldn't liquidate TSLAx — you can retry.");
    expect(killLegUnverifiedReceipt("SOL")).toBe(
      "SOL liquidation couldn't be verified — you can retry.",
    );
  });

  it("refunded legs reuse doc-08's honest refund wording", () => {
    expect(refundedReceipt(12.4)).toBe("Didn't complete — your $12.40 was returned");
  });

  it("aggregate — the doc-13 PROPOSED wording, byte-exact", () => {
    expect(
      killReceiptText({ liquidated: 4, total: 5, retryable: 1, revoked: true }),
    ).toBe("Liquidated 4 of 5 positions to USDC · all agents revoked · 1 leg needs retry");
  });

  it("aggregate — full success drops the retry clause", () => {
    expect(
      killReceiptText({ liquidated: 5, total: 5, retryable: 0, revoked: true }),
    ).toBe("Liquidated 5 of 5 positions to USDC · all agents revoked");
  });

  it("aggregate — plural retry legs", () => {
    expect(
      killReceiptText({ liquidated: 1, total: 3, retryable: 2, revoked: true }),
    ).toBe("Liquidated 1 of 3 positions to USDC · all agents revoked · 2 legs need retry");
  });

  it("aggregate — zero-position kill (all-USDC account)", () => {
    expect(killReceiptText({ liquidated: 0, total: 0, retryable: 0, revoked: true })).toBe(
      "Nothing to liquidate — all agents revoked",
    );
  });

  it("aggregate — a failed revoke never claims 'revoked'", () => {
    expect(
      killReceiptText({ liquidated: 5, total: 5, retryable: 0, revoked: false }),
    ).toBe("Liquidated 5 of 5 positions to USDC · agent revocation still pending");
  });

  it("uses the exact typographic middle dot (U+00B7)", () => {
    const s = killReceiptText({ liquidated: 4, total: 5, retryable: 1, revoked: true });
    expect(s.split("·")).toHaveLength(3);
  });
});
