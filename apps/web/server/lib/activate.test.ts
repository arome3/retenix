import { toUsd6, type PolicyDraft } from "@retenix/shared";
import { assetListHash } from "@retenix/registry";
import { describe, expect, it } from "vitest";
import { resolveActivation } from "./activate";

const canonicalDraft: PolicyDraft = {
  broker: {
    cadence: "weekly",
    amountUsd: 25,
    basket: [
      { assetId: "spyx", pct: 60 },
      { assetId: "tslax", pct: 30 },
      { assetId: "sol", pct: 10 },
    ],
  },
  guardian: { maxDrawdownPct: 15 },
  legacy: { beneficiaryEmail: "ada@example.com", inactivityDays: 180 },
};

const acceptAll = { broker: true, guardian: true, legacy: true };

describe("resolveActivation (doc 10 §Activation)", () => {
  it("resolves the canonical three-section draft to broker + guardian + legacy + onchain", () => {
    const r = resolveActivation({ draft: canonicalDraft, accept: acceptAll, region: "DE" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.broker?.amountUsd).toBe(25);
    expect(r.guardian?.maxDrawdownPct).toBe(15);
    expect(r.legacy?.beneficiaryEmail).toBe("ada@example.com");
    expect(r.onchain?.capPerExec).toBe(toUsd6(15));
    expect(r.onchain?.capPerPeriod).toBe(toUsd6(25));
    expect(r.onchain?.assetListHash).toBe(assetListHash(["sol", "spyx", "tslax"]));
    expect(r.standaloneGuardian).toBe(false);
  });

  it("only activates accepted sections", () => {
    const r = resolveActivation({
      draft: canonicalDraft,
      accept: { broker: true, guardian: false, legacy: false },
      region: "DE",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.broker).toBeDefined();
    expect(r.guardian).toBeUndefined();
    expect(r.legacy).toBeUndefined();
  });

  it("re-validates client edits against the region schema — $30 edit accepted", () => {
    const r = resolveActivation({
      draft: canonicalDraft,
      accept: { broker: true, guardian: false, legacy: false },
      edits: {
        broker: {
          cadence: "weekly",
          amountUsd: 30,
          basket: [{ assetId: "spyx", pct: 100 }],
        },
      },
      region: "DE",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.broker?.amountUsd).toBe(30);
    expect(r.onchain?.capPerExec).toBe(toUsd6(30));
  });

  it("rejects an edit that widens a bound past the schema ($2000)", () => {
    const r = resolveActivation({
      draft: canonicalDraft,
      accept: { broker: true, guardian: false, legacy: false },
      edits: {
        broker: {
          cadence: "weekly",
          amountUsd: 2000,
          basket: [{ assetId: "spyx", pct: 100 }],
        },
      },
      region: "DE",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a broker edit below the $1 floor (PS-F4.1)", () => {
    const r = resolveActivation({
      draft: canonicalDraft,
      accept: { broker: true, guardian: false, legacy: false },
      edits: {
        broker: {
          cadence: "weekly",
          amountUsd: 0.5,
          basket: [{ assetId: "spyx", pct: 100 }],
        },
      },
      region: "DE",
    });
    expect(r.ok).toBe(false);
  });

  it("re-normalizes and region-drops an edited basket (US drops SPYx)", () => {
    const r = resolveActivation({
      draft: canonicalDraft,
      accept: { broker: true, guardian: false, legacy: false },
      edits: {
        broker: {
          cadence: "weekly",
          amountUsd: 25,
          basket: [
            { assetId: "spyx", pct: 60 },
            { assetId: "sol", pct: 40 },
          ],
        },
      },
      region: "US",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.broker?.basket).toEqual([{ assetId: "sol", pct: 100 }]);
  });

  it("flags a standalone guardian (caps with no broker)", () => {
    const r = resolveActivation({
      draft: { guardian: { weeklyCapUsd: 100 } },
      accept: { broker: false, guardian: true, legacy: false },
      region: "DE",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.standaloneGuardian).toBe(true);
    expect(r.onchain).toBeUndefined();
  });

  it("rejects accepting a section the draft doesn't have", () => {
    const r = resolveActivation({
      draft: { guardian: { weeklyCapUsd: 100 } },
      accept: { broker: true, guardian: false, legacy: false },
      region: "DE",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects accepting nothing", () => {
    const r = resolveActivation({
      draft: canonicalDraft,
      accept: { broker: false, guardian: false, legacy: false },
      region: "DE",
    });
    expect(r.ok).toBe(false);
  });
});
