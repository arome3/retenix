import { describe, expect, it } from "vitest";
import {
  needsLiquidationAlert,
  needsLiquidationAutoClose,
  unavailableSummary,
  type HedgeVenue,
  type VenueUnavailableReason,
} from "@retenix/shared";
import { noneVenue } from "./none";

/** Every port method, called uniformly — the point is that NONE of them throw. */
const CALLS: ReadonlyArray<[string, (v: HedgeVenue) => Promise<unknown>]> = [
  ["health", (v) => v.health()],
  ["quoteOpen", (v) => v.quoteOpen({ pairId: "TSLA/USD", notionalUsd: 120, leverageX10: 10 })],
  [
    "buildOpen",
    (v) =>
      v.buildOpen({
        quote: {
          pairId: "TSLA/USD",
          notionalUsd: 120,
          leverageX10: 10,
          collateralUsd: 120,
          estEntryPrice: 100,
          estFeesUsd: 0.5,
          estLiquidationPrice: 200,
          quotedAtMs: 0,
          expiresAtMs: 0,
        },
        ownerAddress: "0xabc",
        clientOrderId: "co_1",
      }),
  ],
  [
    "buildClose",
    (v) =>
      v.buildClose({
        position: {
          venueOrderId: "v1",
          pairId: "TSLA/USD",
          isLong: false,
          notionalUsd: 120,
          leverageX10: 10,
          collateralUsd: 120,
          entryPrice: 100,
          markPrice: 100,
          unrealizedPnlUsd: 0,
          fundingPaidUsd: 0,
          liquidationPrice: 200,
          liquidationBufferPct: 1,
          openedAtMs: 0,
        },
        ownerAddress: "0xabc",
        clientOrderId: "co_1",
      }),
  ],
  [
    "readPosition",
    (v) => v.readPosition({ ownerAddress: "0xabc", pairId: "TSLA/USD", clientOrderId: "co_1" }),
  ],
];

describe("the null venue (what ships while G-H1 is failed)", () => {
  it.each(CALLS)("%s resolves to unavailable and never throws", async (_name, call) => {
    const out = (await call(noneVenue)) as {
      ok: boolean;
      kind?: string;
      reason?: string;
      retryAfterMs?: number | null;
    };
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("unavailable");
    expect(out.reason).toBe("not-configured");
    // Retrying cannot help — a venue has to be chosen first. A number here
    // would send the worker into a pointless retry loop.
    expect(out.retryAfterMs).toBeNull();
  });

  it("never reports a pair for any asset — a guess would be a fake-venue bug", () => {
    for (const id of ["tslax", "spyx", "sol", "paxg", "tsl2l", ""]) {
      expect(noneVenue.pairFor(id)).toBeNull();
    }
  });

  it("health reports UNAVAILABLE, not { paused: true }", async () => {
    // "paused" would imply a venue exists and might resume — something the kill
    // switch could wrongly wait on. "not-configured" is the honest answer.
    const out = await noneVenue.health();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("not-configured");
  });

  it("readPosition is unavailable, never a null position", async () => {
    // null would mean "checked, and you are unhedged". Unavailable means "we do
    // not know" — the caller must not conclude anything about the user's risk.
    const out = await noneVenue.readPosition({
      ownerAddress: "0xabc",
      pairId: "TSLA/USD",
      clientOrderId: "co_1",
    });
    expect(out.ok).toBe(false);
  });

  it("queueLimitOpen is present but unavailable, so the off-hours path falls through", async () => {
    const out = await noneVenue.queueLimitOpen?.({
      quote: {
        pairId: "TSLA/USD",
        notionalUsd: 120,
        leverageX10: 10,
        collateralUsd: 120,
        estEntryPrice: 100,
        estFeesUsd: 0,
        estLiquidationPrice: 200,
        quotedAtMs: 0,
        expiresAtMs: 0,
      },
      limitPrice: 99,
      goodTilMs: 1,
    });
    expect(out?.ok).toBe(false);
  });

  it("is pinned to Arbitrum One, the chain doc 19 specifies", () => {
    expect(noneVenue.chainId).toBe(42161);
    expect(noneVenue.id).toBe("none");
  });
});

describe("liquidation thresholds (doc 19 §Security: alert 20%, auto-close 10%)", () => {
  it("alerts at or below a 20% buffer", () => {
    expect(needsLiquidationAlert({ liquidationBufferPct: 0.21 })).toBe(false);
    expect(needsLiquidationAlert({ liquidationBufferPct: 0.2 })).toBe(true);
    expect(needsLiquidationAlert({ liquidationBufferPct: 0.05 })).toBe(true);
  });

  it("auto-closes at or below a 10% buffer", () => {
    expect(needsLiquidationAutoClose({ liquidationBufferPct: 0.11 })).toBe(false);
    expect(needsLiquidationAutoClose({ liquidationBufferPct: 0.1 })).toBe(true);
  });

  it("auto-close implies alert — the thresholds can never cross", () => {
    for (const pct of [0, 0.05, 0.1, 0.15, 0.2, 0.5, 1]) {
      const p = { liquidationBufferPct: pct };
      if (needsLiquidationAutoClose(p)) expect(needsLiquidationAlert(p)).toBe(true);
    }
  });
});

describe("unavailableSummary reads as receipt copy, never as a claim of a position", () => {
  const REASONS: VenueUnavailableReason[] = [
    "venue-paused",
    "market-closed",
    "oracle-stale",
    "insufficient-liquidity",
    "rate-limited",
    "network",
    "not-configured",
  ];

  it.each(REASONS)("%s yields a lowercase clause with no banned vocabulary", (reason) => {
    const s = unavailableSummary(reason);
    expect(s.length).toBeGreaterThan(0);
    expect(s[0]).toBe(s[0].toLowerCase());
    // G12: these must never leak into a receipt sentence.
    expect(s).not.toMatch(/\b(gas|chain|network|wallet|slippage|perp|margin)\b/i);
  });

  it("never implies a hedge is open", () => {
    for (const reason of REASONS) {
      expect(unavailableSummary(reason)).not.toMatch(/opened|hedged|protected/i);
    }
  });
});
