import { describe, expect, it } from "vitest";

import { withdrawFillFromEvent } from "./portfolio-fills";
import {
  SEND_EVENTS,
  SEND_INVITE_COPY,
  SEND_MAX_USD,
  SEND_MIN_USD,
  sendAuthorizePayloadSchema,
  sendExecutePayloadSchema,
  sendReportPayloadSchema,
} from "./send";

// ---------------------------------------------------------------------------
// Canonical copy — byte-pinned (doc 15 verbatim)
// ---------------------------------------------------------------------------

describe("send canonical copy", () => {
  it("invite copy is doc-15-verbatim (em-dash, exact words)", () => {
    expect(SEND_INVITE_COPY).toBe(
      "They don't have Retenix yet — we've invited them. Nothing was sent.",
    );
  });

  it("event type strings are stable wire constants", () => {
    expect(SEND_EVENTS).toEqual({
      authorized: "send.authorized",
      receipt: "send.receipt",
      received: "send.received",
      invited: "send.invited",
    });
  });
});

// ---------------------------------------------------------------------------
// Wire schemas — the signed payload contract (sweep.ts discipline)
// ---------------------------------------------------------------------------

describe("sendExecutePayloadSchema", () => {
  const authorize = {
    phase: "authorize" as const,
    to: { kind: "email" as const, value: "ana@example.com" },
    amountUsd: 20,
  };

  it("accepts a plain email send", () => {
    expect(sendExecutePayloadSchema.parse(authorize)).toEqual(authorize);
  });

  it("accepts a withdraw (address + asset + chainId)", () => {
    const withdraw = {
      phase: "authorize" as const,
      to: { kind: "address" as const, value: "0x" + "12".repeat(20) },
      amountUsd: 2,
      asset: "usdc",
      chainId: 42161,
    };
    expect(sendExecutePayloadSchema.parse(withdraw)).toEqual(withdraw);
  });

  it("bounds: below $1 and above the v1 ceiling are refused at the schema wall", () => {
    expect(SEND_MIN_USD).toBe(1);
    expect(() =>
      sendAuthorizePayloadSchema.parse({ ...authorize, amountUsd: 0.99 }),
    ).toThrow();
    expect(() =>
      sendAuthorizePayloadSchema.parse({ ...authorize, amountUsd: SEND_MAX_USD + 1 }),
    ).toThrow();
    expect(() =>
      sendAuthorizePayloadSchema.parse({ ...authorize, amountUsd: -5 }),
    ).toThrow();
  });

  it("unknown recipient kinds are refused", () => {
    expect(() =>
      sendAuthorizePayloadSchema.parse({
        ...authorize,
        to: { kind: "phone", value: "555" },
      }),
    ).toThrow();
  });

  it("senderEmail must be an email when present", () => {
    expect(() =>
      sendAuthorizePayloadSchema.parse({ ...authorize, senderEmail: "not-an-email" }),
    ).toThrow();
    expect(
      sendAuthorizePayloadSchema.parse({ ...authorize, senderEmail: "mark@example.com" })
        .senderEmail,
    ).toBe("mark@example.com");
  });

  it("report phase requires a uuid executionId and a known outcome", () => {
    const report = {
      phase: "report" as const,
      executionId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      transactionId: "abc123",
      clientOutcome: "finished" as const,
    };
    expect(sendReportPayloadSchema.parse(report)).toEqual(report);
    expect(() =>
      sendReportPayloadSchema.parse({ ...report, executionId: "not-a-uuid" }),
    ).toThrow();
    expect(() =>
      sendReportPayloadSchema.parse({ ...report, clientOutcome: "maybe" }),
    ).toThrow();
  });

  it("discriminates on phase — a report cannot smuggle authorize fields", () => {
    const parsed = sendExecutePayloadSchema.parse({
      phase: "report",
      executionId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      clientOutcome: "failed",
    });
    expect(parsed.phase).toBe("report");
    expect("to" in parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Withdraw → portfolio-ledger contract (the kill.leg multi-consumer pattern):
// withdraws of ledger-tracked assets (sol/eth) carry payload.ledgerFill; the
// fills pipeline consumes ONLY that field and can never be poisoned by plain
// sends. Cross-contract pins mirror kill.test.ts.
// ---------------------------------------------------------------------------

describe("withdrawFillFromEvent (send.receipt → ledger)", () => {
  it("a sol/eth withdraw with ledgerFill reduces the ledger", () => {
    const mapping = withdrawFillFromEvent({
      payloadJson: {
        receipt: "Withdrew $2.00 of SOL to abc…def on Solana · fees $0.05 · view onchain",
        ledgerFill: { assetId: "sol", qty: 0.0125, usd: 2 },
      },
      atIso: "2026-07-17T00:00:00.000Z",
    });
    expect(mapping).toEqual({
      fill: {
        side: "sell",
        assetId: "sol",
        usd: 2,
        qty: 0.0125,
        at: "2026-07-17T00:00:00.000Z",
      },
    });
  });

  it("plain USDC sends (no ledgerFill) are SKIPPED — never unattributed/poison", () => {
    expect(
      withdrawFillFromEvent({
        payloadJson: { receipt: "Sent $20.00 to a•••@example.com · …" },
        atIso: "2026-07-17T00:00:00.000Z",
      }),
    ).toEqual({ skipped: true });
    expect(withdrawFillFromEvent({ payloadJson: null, atIso: "x" })).toEqual({
      skipped: true,
    });
    expect(
      withdrawFillFromEvent({ payloadJson: { ledgerFill: { qty: 1 } }, atIso: "x" }),
    ).toEqual({ skipped: true });
  });

  it("bad qty/usd degrade to null fields, never NaN", () => {
    const mapping = withdrawFillFromEvent({
      payloadJson: { ledgerFill: { assetId: "eth", qty: -1, usd: "2" } },
      atIso: "2026-07-17T00:00:00.000Z",
    });
    expect(mapping).toEqual({
      fill: {
        side: "sell",
        assetId: "eth",
        usd: null,
        qty: null,
        at: "2026-07-17T00:00:00.000Z",
      },
    });
  });
});
