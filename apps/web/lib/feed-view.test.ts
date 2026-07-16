import { describe, expect, it } from "vitest";
import {
  legFeeText,
  legOutcomeLabel,
  policyQuote,
  receiptMark,
  receiptTimestamp,
} from "./feed-view";

// ---------------------------------------------------------------------------
// DoD time fixtures (DS-9.4): 30 s / 3 h / 25 h / 12 d / 45 d boundaries —
// relative <30d, absolute after, tooltip ALWAYS absolute. relTime/absTime are
// consumed verbatim (doc 01); these fixtures pin the render rules at the
// receipt-row seam.
// ---------------------------------------------------------------------------

describe("receiptTimestamp (DS-9.4 fixtures)", () => {
  // local-constructed to stay TZ-safe
  const now = new Date(2026, 6, 16, 15, 0, 0); // July 16, 2026 3:00 PM local
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const S = 1_000;
  const H = 3_600_000;
  const D = 86_400_000;

  it("30 s → 'just now', tooltip absolute", () => {
    const t = receiptTimestamp(ago(30 * S), now.getTime());
    expect(t.relative).toBe("just now");
    expect(t.absolute).toBe("Jul 16, 2026, 2:59 PM");
  });

  it("3 h → time-of-day", () => {
    const t = receiptTimestamp(ago(3 * H), now.getTime());
    expect(t.relative).toBe("12:00 PM");
    expect(t.absolute).toBe("Jul 16, 2026, 12:00 PM");
  });

  it("25 h → 'Yesterday at …'", () => {
    const t = receiptTimestamp(ago(25 * H), now.getTime());
    expect(t.relative).toBe("Yesterday at 2:00 PM");
    expect(t.absolute).toBe("Jul 15, 2026, 2:00 PM");
  });

  it("12 d → 'Nd ago'", () => {
    const t = receiptTimestamp(ago(12 * D), now.getTime());
    expect(t.relative).toBe("12d ago");
    expect(t.absolute).toBe("Jul 4, 2026, 3:00 PM");
  });

  it("45 d → absolute (past the 30-day line)", () => {
    const t = receiptTimestamp(ago(45 * D), now.getTime());
    expect(t.relative).toBe("Jun 1, 2026");
    expect(t.absolute).toBe("Jun 1, 2026, 3:00 PM");
  });

  it("a frozen nowMs freezes the relative label (feed pause, WCAG 2.2.2)", () => {
    const frozen = now.getTime();
    const atIso = ago(30 * S);
    expect(receiptTimestamp(atIso, frozen).relative).toBe("just now");
    // the wall clock moving on does NOT change the render while paused —
    // the same frozen nowMs yields the same label
    expect(receiptTimestamp(atIso, frozen).relative).toBe("just now");
  });
});

// ---------------------------------------------------------------------------
// Variant marks (C4): blocked = amber shield (proud), executed = teal avatar,
// failed-refunded/system = muted; non-plan rows get a neutral dot.
// ---------------------------------------------------------------------------

describe("receiptMark", () => {
  it("blocked is always the shield — the guardian seen working", () => {
    expect(receiptMark("blocked", "broker")).toEqual({ type: "shield" });
    expect(receiptMark("blocked", null)).toEqual({ type: "shield" });
  });

  it("executed carries the plan-kind avatar at full color", () => {
    expect(receiptMark("executed", "broker")).toEqual({
      type: "avatar",
      agent: "broker",
      muted: false,
    });
    expect(receiptMark("executed", "legacy")).toEqual({
      type: "avatar",
      agent: "legacy",
      muted: false,
    });
  });

  it("failed-refunded and system are muted; sweeps (no plan) get the dot", () => {
    expect(receiptMark("failed-refunded", "broker")).toEqual({
      type: "avatar",
      agent: "broker",
      muted: true,
    });
    expect(receiptMark("system", "guardian")).toEqual({
      type: "avatar",
      agent: "guardian",
      muted: true,
    });
    expect(receiptMark("system", null)).toEqual({ type: "dot" });
    expect(receiptMark("failed-refunded", null)).toEqual({ type: "dot" });
  });
});

// ---------------------------------------------------------------------------
// Aggregate legs
// ---------------------------------------------------------------------------

describe("legOutcomeLabel / legFeeText", () => {
  it("labels the sweep outcome set honestly; unknown outcomes verbatim", () => {
    expect(legOutcomeLabel("finished")).toBe("Done");
    expect(legOutcomeLabel("refunded")).toBe("Returned");
    expect(legOutcomeLabel("failed")).toBe("Didn't complete");
    expect(legOutcomeLabel("unverified")).toBe("Unverified");
    expect(legOutcomeLabel("someday-kill-leg-status")).toBe("someday-kill-leg-status");
  });

  it("fee text honors the feeSource honesty flag", () => {
    const fees = { gas: 0.01, service: 0.02, lp: 0, total: 0.03 };
    expect(legFeeText({ network: "Base", outcome: "finished", fees, feeSource: "settled" })).toBe(
      "$0.03",
    );
    expect(legFeeText({ network: "Base", outcome: "finished", fees, feeSource: "quoted" })).toBe(
      "~$0.03",
    );
    expect(legFeeText({ network: "Base", outcome: "failed", fees, feeSource: "none" })).toBeNull();
    expect(legFeeText({ network: "Base", outcome: "failed" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Policy quote — "because you set: <the plan's C3 terms line>"
// ---------------------------------------------------------------------------

describe("policyQuote", () => {
  it("quotes the broker's invest line", () => {
    expect(
      policyQuote({
        kind: "broker",
        params: {
          cadence: "weekly",
          amountUsd: 25,
          basket: [{ assetId: "spyx", pct: 100 }],
        },
      }),
    ).toBe("$25.00 every week");
  });

  it("quotes the guardian's cap line", () => {
    expect(policyQuote({ kind: "guardian", params: { weeklyCapUsd: 50 } })).toBe("$50.00 a week");
  });

  it("malformed params omit the quote rather than invent one", () => {
    expect(policyQuote({ kind: "broker", params: {} })).toBeNull();
  });
});
