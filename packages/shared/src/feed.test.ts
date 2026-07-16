import { describe, expect, it } from "vitest";
import {
  EXECUTION_STATUSES,
  FEED_EVENT_TYPES,
  buildFeedRows,
  compactSentence,
  dayLabel,
  eventSentence,
  eventVariant,
  executionVariant,
  extractFundingSources,
  feedAgentFrom,
  isUaTxIdFormat,
  splitFeesForDisplay,
  sweepLegsToDetail,
  type FeedItem,
} from "./feed";
import {
  blockedReceipt,
  executedReceipt,
  refundedReceipt,
  skippedReceipt,
} from "./receipts";

// ---------------------------------------------------------------------------
// status → variant map (doc 11 task 1 — total over ALL seven statuses)
// ---------------------------------------------------------------------------

describe("executionVariant", () => {
  it("golden-pins the seven execution statuses (mirror of @retenix/db enum)", () => {
    // If packages/db's executionStatus enum ever changes, this pin forces the
    // feed map to be revisited (shared is a leaf and cannot import db).
    expect(EXECUTION_STATUSES).toEqual([
      "quoted",
      "recorded",
      "submitted",
      "finished",
      "refunded",
      "blocked",
      "failed",
    ]);
  });

  it("maps every status — terminal to a variant, in-flight to null", () => {
    expect(executionVariant("finished")).toBe("executed");
    expect(executionVariant("blocked")).toBe("blocked");
    expect(executionVariant("refunded")).toBe("failed-refunded");
    expect(executionVariant("failed")).toBe("failed-refunded");
    expect(executionVariant("quoted")).toBeNull();
    expect(executionVariant("recorded")).toBeNull();
    expect(executionVariant("submitted")).toBeNull();
  });

  it("is total: no status is unhandled", () => {
    for (const status of EXECUTION_STATUSES) {
      // never throws, always a variant or the deliberate null
      expect([null, "executed", "blocked", "failed-refunded", "system"]).toContain(
        executionVariant(status),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// events allowlist — feed rows vs audit rows
// ---------------------------------------------------------------------------

describe("eventVariant / eventSentence", () => {
  it("every allowlisted type is a system row", () => {
    for (const type of FEED_EVENT_TYPES) {
      expect(eventVariant(type)).toBe("system");
    }
  });

  it("audit event types are NEVER feed rows", () => {
    const audit = [
      "execution.blocked",
      "execution.skipped",
      "execution.failed",
      "execution.unresolved",
      "sweep.authorized",
      "sweep.dismissed",
      "sig.nonce",
      "intent.parsed",
      "plan.autonomy_set",
      "plan.periods_missed",
      "plan.params_invalid",
      "job.resurrected",
      "job.rescue_exhausted",
      "compliance.region_set",
      "compliance.quiz_passed",
      "compliance.identity_simulated",
      "compliance.risk_acknowledged",
      "onboarding.started",
      "onboarding.ready",
    ];
    for (const type of audit) {
      expect(eventVariant(type), type).toBeNull();
    }
  });

  it("reads the sentence from the right field per type", () => {
    expect(
      eventSentence("sweep.receipt", { headline: "+$23.11 rescued from 5 networks." }),
    ).toBe("+$23.11 rescued from 5 networks.");
    expect(
      eventSentence("plan.activated", { receipt: "Your Broker is hired — $25.00 every week across SPYx." }),
    ).toBe("Your Broker is hired — $25.00 every week across SPYx.");
    // module 13's rows (kill.leg landed as a forward contract; kill.receipt
    // is the aggregate) + module 14's forward contract
    expect(eventSentence("kill.leg", { receipt: "Sold …" })).toBe("Sold …");
    expect(
      eventSentence("kill.receipt", {
        receipt: "Liquidated 4 of 5 positions to USDC · all agents revoked · 1 leg needs retry",
      }),
    ).toBe("Liquidated 4 of 5 positions to USDC · all agents revoked · 1 leg needs retry");
    expect(eventSentence("estate.checkin", { receipt: "Checked in." })).toBe("Checked in.");
  });

  it("never fabricates: missing/non-string/empty sentence → null", () => {
    expect(eventSentence("plan.activated", {})).toBeNull();
    expect(eventSentence("plan.activated", { receipt: 42 })).toBeNull();
    expect(eventSentence("plan.activated", { receipt: "" })).toBeNull();
    expect(eventSentence("plan.activated", null)).toBeNull();
    expect(eventSentence("sweep.receipt", { receipt: "wrong field" })).toBeNull();
    // an in-flight kill leg has no receipt yet → skipped, never invented
    expect(eventSentence("kill.leg", { outcome: "submitted" })).toBeNull();
  });

  it("kill.receipt legs flow through sweepLegsToDetail (SweepReceiptLeg-shaped)", () => {
    const legs = sweepLegsToDetail({
      legs: [
        {
          chainId: 101,
          network: "Solana",
          symbol: "SPYx",
          usd: 32.11,
          outcome: "settled",
          serverVerified: true,
          transactionId: "killtx1234567890",
        },
      ],
    });
    expect(legs).toEqual([
      {
        network: "Solana",
        symbol: "SPYx",
        usd: 32.11,
        outcome: "settled",
        serverVerified: true,
        fees: undefined,
        feeSource: undefined,
        uaTxId: "killtx1234567890",
        error: undefined,
      },
    ]);
  });

  it("feedAgentFrom accepts only plan kinds", () => {
    expect(feedAgentFrom("broker")).toBe("broker");
    expect(feedAgentFrom("guardian")).toBe("guardian");
    expect(feedAgentFrom("legacy")).toBe("legacy");
    expect(feedAgentFrom("continuity")).toBeNull();
    expect(feedAgentFrom(undefined)).toBeNull();
    expect(feedAgentFrom(7)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// compact transform (CONFLICTS #18 — mechanical elisions only)
// ---------------------------------------------------------------------------

describe("compactSentence", () => {
  const canonical = executedReceipt({
    usd: 15,
    ticker: "SPYx",
    sources: ["Base", "Arbitrum"],
    fees: { gas: 0.03, service: 0.08, lp: 0.03, total: 0.14 },
  });

  it("the canonical executed sample compacts byte-exactly (C4 row form)", () => {
    // spec-verbatim stored sentence…
    expect(canonical).toBe(
      "Bought $15.00 of SPYx · funded from Base + Arbitrum · fees $0.14 (gas $0.03, service $0.08, LP $0.03) · view onchain",
    );
    // …and its sanctioned compact form: parenthetical + link tail elided,
    // sources counted (G12), ▲ decorative (G14).
    expect(compactSentence(canonical)).toBe(
      "Bought $15.00 of SPYx · ▲ funded from 2 sources · fees $0.14",
    );
  });

  it("single source reads singular", () => {
    const s = executedReceipt({
      usd: 2.5,
      ticker: "SOL",
      sources: ["Solana"],
      fees: { gas: 0.01, service: 0.02, lp: 0, total: 0.03 },
    });
    expect(compactSentence(s)).toBe(
      "Bought $2.50 of SOL · ▲ funded from 1 source · fees $0.03",
    );
  });

  it("the 'your balance' fallback sentence passes through un-rewritten", () => {
    const s = executedReceipt({
      usd: 15,
      ticker: "SPYx",
      sources: [],
      fees: { gas: 0.03, service: 0.08, lp: 0.03, total: 0.14 },
    });
    expect(compactSentence(s)).toBe(
      "Bought $15.00 of SPYx · funded from your balance · fees $0.14",
    );
  });

  it("networkName's unknown-id fallback ('Source N') still counts as a source", () => {
    const s = executedReceipt({
      usd: 5,
      ticker: "ETH",
      sources: ["Base", "Source 424242"],
      fees: { gas: 0.01, service: 0.01, lp: 0.01, total: 0.03 },
    });
    expect(compactSentence(s)).toBe(
      "Bought $5.00 of ETH · ▲ funded from 2 sources · fees $0.03",
    );
  });

  it("non-executed canonical sentences are untouched (byte-for-byte)", () => {
    const blocked = blockedReceipt("OverPeriodCap", "$50 weekly cap");
    expect(blocked).toBe("Blocked: exceeds your $50 weekly cap"); // CONFLICTS #10
    expect(compactSentence(blocked)).toBe(blocked);

    const refunded = refundedReceipt(15);
    expect(refunded).toBe("Didn't complete — your $15.00 was returned");
    expect(compactSentence(refunded)).toBe(refunded);

    const skipped = skippedReceipt({
      usd: 15,
      ticker: "SPYx",
      shortUsd: 3.12,
      cadence: "weekly",
    });
    expect(compactSentence(skipped)).toBe(skipped);

    const headline = "+$23.11 rescued from 5 networks."; // copy-canon-allow (stored receipt fixture)
    expect(compactSentence(headline)).toBe(headline);
  });
});

// ---------------------------------------------------------------------------
// fee-split display — Σ(displayed parts) === displayed total (PS-10.6 / G8)
// ---------------------------------------------------------------------------

describe("splitFeesForDisplay", () => {
  const centsOf = (s: string) => Math.round(Number(s.replace(/[$,]/g, "")) * 100);

  it("canonical split renders exactly and sums", () => {
    const d = splitFeesForDisplay({ gas: 0.03, service: 0.08, lp: 0.03, total: 0.14 });
    expect(d).toEqual({ gas: "$0.03", service: "$0.08", lp: "$0.03", total: "$0.14" });
  });

  it("the $0.135 rounding edge reconciles (DoD fixture)", () => {
    // naive per-part rounding would show $0.05 ×3 = $0.15 against a $0.14 total
    const d = splitFeesForDisplay({ gas: 0.045, service: 0.045, lp: 0.045, total: 0.135 });
    expect(d.total).toBe("$0.14");
    expect(centsOf(d.gas) + centsOf(d.service) + centsOf(d.lp)).toBe(centsOf(d.total));
    // every displayed part stays within half a cent of its stored value
    for (const part of [d.gas, d.service, d.lp]) {
      expect(Math.abs(centsOf(part) - 4.5)).toBeLessThanOrEqual(0.5);
    }
  });

  it("sums for a spread of fixtures (property)", () => {
    const fixtures = [
      { gas: 0, service: 0, lp: 0, total: 0 },
      { gas: 0.005, service: 0.005, lp: 0.005, total: 0.015 },
      { gas: 0.29, service: 0.01, lp: 0.001, total: 0.301 },
      { gas: 1.111, service: 2.222, lp: 3.333, total: 6.666 },
      { gas: 0.333, service: 0.333, lp: 0.334, total: 1 },
    ];
    for (const f of fixtures) {
      const d = splitFeesForDisplay(f);
      expect(
        centsOf(d.gas) + centsOf(d.service) + centsOf(d.lp),
        JSON.stringify(f),
      ).toBe(centsOf(d.total));
    }
  });

  it("never emits NaN, even on defensive input", () => {
    const d = splitFeesForDisplay({ gas: Number.NaN, service: 0.01, lp: 0.01, total: 0.02 });
    for (const v of Object.values(d)) expect(v).toMatch(/^\$[\d,]+\.\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// universalx id guard — never build links from unvalidated strings
// ---------------------------------------------------------------------------

describe("isUaTxIdFormat", () => {
  it("accepts plausible transaction ids", () => {
    expect(isUaTxIdFormat("a1b2c3d4e5f6")).toBe(true);
    expect(isUaTxIdFormat("0x0123456789abcdef0123456789abcdef")).toBe(true); // hex with 0x prefix is URL-safe
    expect(isUaTxIdFormat("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isUaTxIdFormat("tx_ABC-123_def")).toBe(true);
  });

  it("rejects anything that could alter the URL or is malformed", () => {
    expect(isUaTxIdFormat("")).toBe(false);
    expect(isUaTxIdFormat("short")).toBe(false); // < 8 chars
    expect(isUaTxIdFormat("has space")).toBe(false);
    expect(isUaTxIdFormat("javascript:alert(1)")).toBe(false);
    expect(isUaTxIdFormat("abc12345?x=1")).toBe(false);
    expect(isUaTxIdFormat("abc12345&y=2")).toBe(false);
    expect(isUaTxIdFormat("../../etc/passwd")).toBe(false);
    expect(isUaTxIdFormat("abc12345#frag")).toBe(false);
    expect(isUaTxIdFormat("a".repeat(129))).toBe(false);
    expect(isUaTxIdFormat(42)).toBe(false);
    expect(isUaTxIdFormat(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// funding sources extractor (relocated from the worker — same fixtures)
// ---------------------------------------------------------------------------

describe("extractFundingSources", () => {
  it("prefers depositTokens from the detail payload", () => {
    expect(
      extractFundingSources(
        { depositTokens: [{ token: { chainId: 8453 } }, { chainId: 42161 }] },
        { userOps: [{ chainId: 1 }] },
      ),
    ).toEqual(["Base", "Arbitrum"]);
  });

  it("falls back to the quote's userOps", () => {
    expect(
      extractFundingSources(undefined, { userOps: [{ chainId: 101 }, { chainId: 1 }] }),
    ).toEqual(["Solana", "Ethereum"]);
  });

  it("dedupes chains and tolerates junk", () => {
    expect(
      extractFundingSources(
        { depositTokens: [{ chainId: 8453 }, { chainId: 8453 }, { nope: true }] },
        null,
      ),
    ).toEqual(["Base"]);
    expect(extractFundingSources({ weird: true }, null)).toEqual([]);
  });

  it("unknown chain ids get the canon-safe fallback name", () => {
    expect(extractFundingSources({ depositTokens: [{ chainId: 424242 }] }, null)).toEqual([
      "Source 424242",
    ]);
  });
});

// ---------------------------------------------------------------------------
// sweep legs → LegDetail (module 06 payload; links rebuilt from guarded ids)
// ---------------------------------------------------------------------------

describe("sweepLegsToDetail", () => {
  const leg = {
    chainId: 8453,
    network: "Base",
    token: "0xabc",
    symbol: "DEGEN",
    usd: 0.61,
    transactionId: "abcdef1234567890",
    outcome: "finished",
    serverVerified: true,
    fees: { gas: 0.01, service: 0.02, lp: 0, total: 0.03 },
    feeSource: "settled",
    activityUrl: "https://evil.example/phish", // must be IGNORED
  };

  it("maps legs and rebuilds link ids only from guarded transactionIds", () => {
    const out = sweepLegsToDetail({ legs: [leg] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      network: "Base",
      symbol: "DEGEN",
      usd: 0.61,
      outcome: "finished",
      serverVerified: true,
      feeSource: "settled",
      uaTxId: "abcdef1234567890",
    });
    // the stored URL string never crosses into the detail shape
    expect(JSON.stringify(out)).not.toContain("evil.example");
  });

  it("drops the id (not the leg) when the transactionId fails the guard", () => {
    const out = sweepLegsToDetail({
      legs: [{ ...leg, transactionId: "javascript:alert(1)" }],
    });
    expect(out[0].uaTxId).toBeUndefined();
    expect(out[0].outcome).toBe("finished");
  });

  it("skips malformed legs and tolerates absent payloads", () => {
    expect(sweepLegsToDetail({ legs: [{ nope: 1 }, leg] })).toHaveLength(1);
    expect(sweepLegsToDetail({})).toEqual([]);
    expect(sweepLegsToDetail(null)).toEqual([]);
  });

  it("invalid fee shapes degrade to absent, never invented", () => {
    const out = sweepLegsToDetail({ legs: [{ ...leg, fees: { gas: "a" } }] });
    expect(out[0].fees).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// day dividers (DS-9.4 register: "Today", "Yesterday", then "July 24")
// ---------------------------------------------------------------------------

describe("dayLabel / buildFeedRows", () => {
  // all fixtures built via the LOCAL Date constructor → TZ/DST-safe
  const now = new Date(2026, 6, 16, 15, 0, 0); // July 16, 2026 3:00 PM local
  const iso = (d: Date) => d.toISOString();

  it("labels per the spec register", () => {
    expect(dayLabel(iso(new Date(2026, 6, 16, 9, 0)), now.getTime())).toBe("Today");
    expect(dayLabel(iso(new Date(2026, 6, 15, 23, 59)), now.getTime())).toBe("Yesterday");
    expect(dayLabel(iso(new Date(2026, 6, 4, 12, 0)), now.getTime())).toBe("July 4");
    expect(dayLabel(iso(new Date(2025, 11, 31, 12, 0)), now.getTime())).toBe(
      "December 31, 2025",
    );
  });

  const item = (id: string, at: Date): FeedItem => ({
    id,
    at: iso(at),
    variant: "system",
    sentence: "Your Broker is back on duty.",
    agent: "broker",
  });

  it("inserts one divider per day and preserves order", () => {
    const rows = buildFeedRows(
      [
        item("a", new Date(2026, 6, 16, 14, 0)),
        item("b", new Date(2026, 6, 16, 9, 0)),
        item("c", new Date(2026, 6, 15, 20, 0)),
        item("d", new Date(2026, 6, 4, 8, 0)),
      ],
      now.getTime(),
    );
    expect(
      rows.map((r) => (r.kind === "divider" ? `#${r.label}` : r.item.id)),
    ).toEqual(["#Today", "a", "b", "#Yesterday", "c", "#July 4", "d"]);
  });

  it("dedupes by item id (page-boundary insurance under prepends)", () => {
    const rows = buildFeedRows(
      [item("a", new Date(2026, 6, 16, 14, 0)), item("a", new Date(2026, 6, 16, 14, 0))],
      now.getTime(),
    );
    expect(rows.filter((r) => r.kind === "receipt")).toHaveLength(1);
  });

  it("divider keys are stable and distinct from item ids", () => {
    const rows = buildFeedRows([item("a", new Date(2026, 6, 16, 14, 0))], now.getTime());
    expect(rows[0]).toMatchObject({ kind: "divider", key: "d:2026-7-16" });
    expect(rows[1]).toMatchObject({ kind: "receipt", key: "a" });
  });
});
