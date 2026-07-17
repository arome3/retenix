import { describe, expect, it } from "vitest";

import {
  blockedReceipt,
  capText,
  executedReceipt,
  fmtUsd,
  periodWord,
  receivedReceipt,
  refundedReceipt,
  revokedReceipt,
  sendFailedReceipt,
  sendUnverifiedReceipt,
  sentReceipt,
  skippedReceipt,
  unresolvedReceipt,
  withdrawReceipt,
} from "./receipts";

// ---------------------------------------------------------------------------
// The four canonical sample strings from doc 08 — byte-exact. These literals
// are a DELIBERATE second copy of the spec samples so that any edit to
// receipts.ts (or an ICU/runtime drift) fails CI, mirroring the golden-pin
// pattern of packages/registry/src/assets.golden.test.ts.
// ---------------------------------------------------------------------------

describe("canonical receipt samples (byte-exact)", () => {
  it("executed — spec-verbatim sample", () => {
    expect(
      executedReceipt({
        usd: 15,
        ticker: "SPYx",
        sources: ["Base", "Arbitrum"],
        fees: { gas: 0.03, service: 0.08, lp: 0.03, total: 0.14 },
      }),
    ).toBe(
      "Bought $15.00 of SPYx · funded from Base + Arbitrum · fees $0.14 (gas $0.03, service $0.08, LP $0.03) · view onchain",
    );
  });

  it("executed — dirty binary-float totals still render clean", () => {
    // parseFeeTotals sums floats; 0.1 + 0.2 is the classic dirty case.
    const gas = 0.1,
      service = 0.2,
      lp = 0;
    const total = gas + service + lp; // 0.30000000000000004
    expect(total).not.toBe(0.3);
    expect(
      executedReceipt({
        usd: 15,
        ticker: "SPYx",
        sources: ["Base", "Arbitrum"],
        fees: { gas, service, lp, total },
      }),
    ).toBe(
      "Bought $15.00 of SPYx · funded from Base + Arbitrum · fees $0.30 (gas $0.10, service $0.20, LP $0.00) · view onchain",
    );
  });

  it("blocked — product-spec wording, CONFLICTS #10 (never 'this exceeded')", () => {
    expect(blockedReceipt("OverPeriodCap", "$50 weekly cap")).toBe(
      "Blocked: exceeds your $50 weekly cap",
    );
    expect(blockedReceipt("OverExecCap", "$50 per-trade cap")).toBe(
      "Blocked: exceeds your $50 per-trade cap",
    );
  });

  it("refunded — DS-C4 failed-refunded wording", () => {
    expect(refundedReceipt(15)).toBe("Didn't complete — your $15.00 was returned");
  });

  it("skipped — PS-F4.4 sample, byte-exact", () => {
    expect(
      skippedReceipt({ usd: 15, ticker: "SPYx", shortUsd: 3.12, cadence: "weekly" }),
    ).toBe(
      "Skipped this week's $15.00 SPYx buy — your buying power was $3.12 short. I'll try again next period.",
    );
  });

  it("uses the exact typographic characters (middle dot U+00B7, em-dash U+2014)", () => {
    const executed = executedReceipt({
      usd: 1,
      ticker: "SOL",
      sources: ["Base"],
      fees: { gas: 0, service: 0, lp: 0, total: 0 },
    });
    expect(executed.split("·")).toHaveLength(4); // three separators
    expect(refundedReceipt(1)).toContain(" — ");
    expect(
      skippedReceipt({ usd: 1, ticker: "SOL", shortUsd: 1, cadence: "daily" }),
    ).toContain(" — ");
  });
});

describe("blocked variants (PROPOSED wordings — golden-pinned)", () => {
  it("AssetNotAllowed", () => {
    expect(blockedReceipt("AssetNotAllowed", "")).toBe(
      "Blocked: that asset isn't in your plan",
    );
  });
  it("NotActive", () => {
    expect(blockedReceipt("NotActive", "")).toBe(
      "Blocked: this plan is no longer active",
    );
  });
  it("NotAgent", () => {
    expect(blockedReceipt("NotAgent", "")).toBe(
      "Blocked: not authorized by your plan",
    );
  });
  it("Unknown fallback", () => {
    expect(blockedReceipt("Unknown", "")).toBe(
      "Blocked: this didn't pass your plan's checks",
    );
  });
});

describe("skipped cadence parameterization", () => {
  it("daily → today's", () => {
    expect(
      skippedReceipt({ usd: 2, ticker: "SOL", shortUsd: 0.5, cadence: "daily" }),
    ).toBe(
      "Skipped today's $2.00 SOL buy — your buying power was $0.50 short. I'll try again next period.",
    );
  });
  it("monthly → this month's", () => {
    expect(
      skippedReceipt({ usd: 100, ticker: "QQQx", shortUsd: 12, cadence: "monthly" }),
    ).toBe(
      "Skipped this month's $100.00 QQQx buy — your buying power was $12.00 short. I'll try again next period.",
    );
  });
});

describe("halt receipts (PROPOSED — golden-pinned)", () => {
  it("revoked mid-flight — never claims money moved", () => {
    const r = revokedReceipt(15, "SPYx");
    expect(r).toBe(
      "Cancelled — this plan was revoked before your $15.00 SPYx buy went out",
    );
    expect(r).not.toContain("returned");
  });
  it("paused variant", () => {
    expect(revokedReceipt(15, "SPYx", "paused")).toBe(
      "Cancelled — this plan was paused before your $15.00 SPYx buy went out",
    );
  });
  it("unresolved — never claims a refund", () => {
    const r = unresolvedReceipt(15, "SPYx");
    expect(r).toBe(
      "Still settling — your $15.00 SPYx buy hasn't confirmed yet. We're checking on it.",
    );
    expect(r).not.toContain("returned");
  });
});

describe("fmtUsd (receipt-grade — distinct from web's compacting fmtUsd)", () => {
  it("always two decimals with $ prefix", () => {
    expect(fmtUsd(15)).toBe("$15.00");
    expect(fmtUsd(0.14)).toBe("$0.14");
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(3.125)).toBe("$3.13"); // half-even is NOT used by Intl currency (half-up here)
  });
  it("thousands separators, and NO ≥$100K compaction (unlike apps/web)", () => {
    expect(fmtUsd(1234.5)).toBe("$1,234.50");
    expect(fmtUsd(1_240_000)).toBe("$1,240,000.00"); // web would say "$1.24M"
  });
});

describe("capText", () => {
  it("whole dollars drop the cents — matches product-spec '$50 weekly cap'", () => {
    expect(capText(50_000_000n, 604_800, "period")).toBe("$50 weekly cap");
    expect(capText(50_000_000n, 604_800, "exec")).toBe("$50 per-trade cap");
  });
  it("fractional caps keep two decimals", () => {
    expect(capText(52_500_000n, 86_400, "period")).toBe("$52.50 daily cap");
  });
  it("period words cover the spec cadences and demo-scaled windows", () => {
    expect(periodWord(86_400)).toBe("daily");
    expect(periodWord(604_800)).toBe("weekly");
    expect(periodWord(2_592_000)).toBe("monthly"); // 30-day cap window
    expect(periodWord(172_800)).toBe("2-day");
    expect(periodWord(7_200)).toBe("2-hour");
    expect(periodWord(120)).toBe("120-second"); // demo-scaled
  });
});

describe("executedReceipt source handling", () => {
  it("single source has no separator", () => {
    expect(
      executedReceipt({
        usd: 2,
        ticker: "SOL",
        sources: ["Arbitrum"],
        fees: { gas: 0.01, service: 0.02, lp: 0, total: 0.03 },
      }),
    ).toBe(
      "Bought $2.00 of SOL · funded from Arbitrum · fees $0.03 (gas $0.01, service $0.02, LP $0.00) · view onchain",
    );
  });
  it("empty sources fall back to a sentence that still reads", () => {
    expect(
      executedReceipt({
        usd: 2,
        ticker: "SOL",
        sources: [],
        fees: { gas: 0, service: 0, lp: 0, total: 0 },
      }),
    ).toContain("funded from your balance");
  });
});

// ---------------------------------------------------------------------------
// send / withdraw receipts (module 15) — byte-pinned like every other family.
// The sender/recipient samples mirror doc 15's own examples ("Sent $20.00 to
// ana@… · fees $0.05 · view onchain" / "Received $20.00 from mark@…") with
// masked-email displays (raw emails never persist — doc 14's maskEmail).
// ---------------------------------------------------------------------------

describe("send receipts (byte-exact)", () => {
  const fees = { gas: 0.02, service: 0.02, lp: 0.01, total: 0.05 };

  it("sender receipt — doc 15 sample shape", () => {
    expect(sentReceipt({ usd: 20, toDisplay: "a•••@example.com", fees })).toBe(
      "Sent $20.00 to a•••@example.com · fees $0.05 · view onchain",
    );
  });

  it("sender receipt to a raw address renders it truncated (DS-9.3)", () => {
    expect(sentReceipt({ usd: 2, toDisplay: "0x1234…abcd", fees })).toBe(
      "Sent $2.00 to 0x1234…abcd · fees $0.05 · view onchain",
    );
  });

  it("recipient receipt — doc 15 sample shape", () => {
    expect(receivedReceipt(20, "m•••@example.com")).toBe(
      "Received $20.00 from m•••@example.com",
    );
  });

  it("withdraw receipt names the destination network (receipt context)", () => {
    expect(
      withdrawReceipt({
        usd: 2,
        symbol: "USDC",
        toDisplay: "0x1234…abcd",
        network: "Arbitrum",
        fees,
      }),
    ).toBe("Withdrew $2.00 of USDC to 0x1234…abcd on Arbitrum · fees $0.05 · view onchain");
  });

  it("failed send is honest that nothing left; unverified never claims either way", () => {
    expect(sendFailedReceipt(2, "a•••@example.com")).toBe(
      "Didn't complete — your $2.00 send to a•••@example.com never left your account",
    );
    expect(sendUnverifiedReceipt(2, "a•••@example.com")).toBe(
      "Still settling — your $2.00 send to a•••@example.com hasn't confirmed yet. We're checking on it.",
    );
  });
});
