import { assetListHash } from "@retenix/registry";
import { toUsd6, type BrokerSection, type GuardianSection } from "@retenix/shared";
import { describe, expect, it } from "vitest";
import {
  CADENCE_PERIOD_SECS,
  capPerExecUsd,
  capPerPeriodUsd,
  toOnchainPlanParams,
} from "./activation-mapping";

const broker = (over: Partial<BrokerSection> = {}): BrokerSection => ({
  cadence: "weekly",
  amountUsd: 25,
  basket: [
    { assetId: "spyx", pct: 60 },
    { assetId: "tslax", pct: 30 },
    { assetId: "sol", pct: 10 },
  ],
  ...over,
});

describe("periodSecs table (doc 10 PROPOSED constant)", () => {
  it("pins the three windows; monthly = 30 days (matches doc 08 cap window)", () => {
    expect(CADENCE_PERIOD_SECS).toEqual({
      daily: 86_400,
      weekly: 604_800,
      monthly: 2_592_000,
    });
  });
});

describe("capPerExecUsd — largest FINAL leg (PROPOSED, doc 10)", () => {
  it("$25 60/30/10 → legs 15/7.5/2.5 → capPerExec $15", () => {
    expect(capPerExecUsd(broker())).toBe(15);
  });

  it("single-asset plan → capPerExec == amountUsd", () => {
    expect(
      capPerExecUsd(broker({ basket: [{ assetId: "spyx", pct: 100 }] })),
    ).toBe(25);
  });

  it("uses the POST-merge leg, not naive pct×amount", () => {
    // $10 at 95/5 → naive legs 9.50 / 0.50; the sub-$1 leg merges up to $10.
    // Sizing off the naive 9.50 would let the contract block the real $10 leg.
    const cap = capPerExecUsd(
      broker({
        amountUsd: 10,
        basket: [
          { assetId: "spyx", pct: 95 },
          { assetId: "sol", pct: 5 },
        ],
      }),
    );
    expect(cap).toBe(10);
  });
});

describe("capPerPeriodUsd — tightest applicable cap, normalized (doc 10)", () => {
  it("no guardian cap → the plan's own amount is the period ceiling", () => {
    expect(capPerPeriodUsd(broker(), undefined, CADENCE_PERIOD_SECS.weekly)).toBe(25);
  });

  it("weekly plan + $50 weekly guardian cap → min(25, 50) = 25", () => {
    const g: GuardianSection = { weeklyCapUsd: 50 };
    expect(capPerPeriodUsd(broker(), g, CADENCE_PERIOD_SECS.weekly)).toBe(25);
  });

  it("weekly plan + $10 weekly guardian cap → min(25, 10) = 10 (guardian binds)", () => {
    const g: GuardianSection = { weeklyCapUsd: 10 };
    expect(capPerPeriodUsd(broker(), g, CADENCE_PERIOD_SECS.weekly)).toBe(10);
  });

  it("daily plan scales the weekly guardian cap down to one day", () => {
    // $70/week guardian on a $5/day plan → weekly cap scales to $10/day →
    // min($5, $10) = $5.
    const daily = broker({ cadence: "daily", amountUsd: 5, basket: [{ assetId: "sol", pct: 100 }] });
    const g: GuardianSection = { weeklyCapUsd: 70 };
    expect(capPerPeriodUsd(daily, g, CADENCE_PERIOD_SECS.daily)).toBe(5);
  });

  it("daily plan where the scaled guardian cap binds", () => {
    // $7/week guardian → $1/day; a $5/day plan is capped to $1/day.
    const daily = broker({ cadence: "daily", amountUsd: 5, basket: [{ assetId: "sol", pct: 100 }] });
    const g: GuardianSection = { weeklyCapUsd: 7 };
    expect(capPerPeriodUsd(daily, g, CADENCE_PERIOD_SECS.daily)).toBe(1);
  });
});

describe("toOnchainPlanParams", () => {
  it("maps the canonical card to usd6 params + sorted assetListHash (doc 05)", () => {
    const params = toOnchainPlanParams(broker(), { maxDrawdownPct: 15 });
    expect(params.capPerExec).toBe(toUsd6(15));
    expect(params.capPerPeriod).toBe(toUsd6(25));
    expect(params.periodSecs).toBe(604_800);
    // ids sorted, deduped — the "|"-preimage assetListHash expects.
    expect(params.assetIds).toEqual(["sol", "spyx", "tslax"]);
    expect(params.assetListHash).toBe(assetListHash(["sol", "spyx", "tslax"]));
  });

  it("uses the guardian weekly cap when it binds", () => {
    const params = toOnchainPlanParams(broker(), { weeklyCapUsd: 12 });
    expect(params.capPerPeriod).toBe(toUsd6(12));
  });

  it("all usd values are usd6 bigints (CONFLICTS #11 — the one encode site)", () => {
    const params = toOnchainPlanParams(broker(), undefined);
    expect(typeof params.capPerExec).toBe("bigint");
    expect(typeof params.capPerPeriod).toBe("bigint");
  });
});
