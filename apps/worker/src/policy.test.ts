import { describe, expect, it } from "vitest";
import { assetIdHash } from "@retenix/registry";
import { blockedReceipt, capText, toUsd6 } from "@retenix/shared";

import { decodePolicyError, policyErrorSelectors, policyInterface } from "./policy";

describe("policy error selectors", () => {
  it("match the selectors recorded during the doc-07 Sepolia rehearsal", () => {
    // Independent second copy (docs/deployments.md) — drift in the ABI or
    // in ethers' selector derivation goes red here.
    expect(policyErrorSelectors()).toMatchObject({
      NotActive: "0x80cb55e2",
      OverExecCap: "0xc5ed6221",
      OverPeriodCap: "0x4a706fdc",
      AssetNotAllowed: "0x48472343",
    });
    expect(policyErrorSelectors().NotAgent).toMatch(/^0x[0-9a-f]{8}$/);
  });
});

describe("decodePolicyError", () => {
  const revertData = (name: string) => policyInterface.encodeErrorResult(name, []);

  it("decodes each custom error from raw revert data", () => {
    for (const name of [
      "NotActive",
      "NotAgent",
      "OverExecCap",
      "OverPeriodCap",
      "AssetNotAllowed",
    ] as const) {
      expect(decodePolicyError({ data: revertData(name) })).toBe(name);
    }
  });

  it("finds revert data in ethers' nested error shapes", () => {
    const data = revertData("OverPeriodCap");
    expect(decodePolicyError({ info: { error: { data } } })).toBe("OverPeriodCap");
    expect(decodePolicyError({ error: { data } })).toBe("OverPeriodCap");
    expect(decodePolicyError({ cause: { data } })).toBe("OverPeriodCap");
  });

  it("maps non-execution errors and garbage to Unknown (deterministic sentence)", () => {
    expect(decodePolicyError({ data: revertData("BadNonce") })).toBe("Unknown");
    expect(decodePolicyError({ data: "0xdeadbeef00" })).toBe("Unknown");
    expect(decodePolicyError(new Error("connection reset"))).toBe("Unknown");
    expect(decodePolicyError(undefined)).toBe("Unknown");
  });
});

describe("error → canonical receipt sentence (the doc-08 map)", () => {
  it("OverPeriodCap on a $50 weekly plan → the demo-beat-5 sentence", () => {
    const reason = decodePolicyError({
      data: policyInterface.encodeErrorResult("OverPeriodCap", []),
    });
    expect(blockedReceipt(reason, capText(50_000_000n, 604_800, "period"))).toBe(
      "Blocked: exceeds your $50 weekly cap",
    );
  });

  it("OverExecCap → per-trade cap wording", () => {
    expect(blockedReceipt("OverExecCap", capText(50_000_000n, 604_800, "exec"))).toBe(
      "Blocked: exceeds your $50 per-trade cap",
    );
  });

  it("AssetNotAllowed → the plan-membership wording", () => {
    expect(blockedReceipt("AssetNotAllowed", "")).toBe(
      "Blocked: that asset isn't in your plan",
    );
  });
});

describe("usd6 calldata discipline (CONFLICTS #11)", () => {
  it("recordExecution encodes $15.00 as exactly 15_000_000", () => {
    const data = policyInterface.encodeFunctionData("recordExecution", [
      1n,
      toUsd6(15),
      assetIdHash("spyx"),
    ]);
    const [id, usd, asset] = policyInterface.decodeFunctionData("recordExecution", data);
    expect(id).toBe(1n);
    expect(usd).toBe(15_000_000n);
    expect(asset).toBe(assetIdHash("spyx"));
  });

  it("refundExecution round-trips the same encoding", () => {
    const data = policyInterface.encodeFunctionData("refundExecution", [7n, toUsd6(2.5)]);
    const [, usd] = policyInterface.decodeFunctionData("refundExecution", data);
    expect(usd).toBe(2_500_000n);
  });
});
