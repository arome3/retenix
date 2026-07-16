import { describe, expect, it } from "vitest";
import { policyDraftFor, type PolicyDraft } from "./policy-draft";

// A stand-in id tuple; the registry binding is golden-tested in
// @retenix/registry (policy-draft.test.ts) against the real REGISTRY_IDS.
const IDS: [string, ...string[]] = ["spyx", "tslax", "sol"];
const schema = policyDraftFor(IDS);

const broker = (over: Partial<NonNullable<PolicyDraft["broker"]>> = {}) => ({
  broker: {
    cadence: "weekly" as const,
    amountUsd: 25,
    basket: [{ assetId: "spyx", pct: 100 }],
    ...over,
  },
});

describe("policyDraftFor — the schema wall (tech spec §8, guardrail 2)", () => {
  it("accepts the empty draft {} (no policy intent)", () => {
    expect(schema.safeParse({}).success).toBe(true);
  });

  it("accepts the canonical three-section shape", () => {
    const parsed = schema.safeParse({
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
    });
    expect(parsed.success).toBe(true);
  });

  describe("broker bounds", () => {
    it.each([[0], [1000.01], [-5]])("rejects amountUsd %s", (amountUsd) => {
      expect(schema.safeParse(broker({ amountUsd })).success).toBe(false);
    });

    it("accepts amountUsd at the $1000 bound", () => {
      expect(schema.safeParse(broker({ amountUsd: 1000 })).success).toBe(true);
    });

    it("rejects a basket of 6 legs", () => {
      const basket = Array.from({ length: 6 }, () => ({
        assetId: "sol",
        pct: 10,
      }));
      expect(schema.safeParse(broker({ basket })).success).toBe(false);
    });

    it("accepts a basket of 5 legs", () => {
      const basket = Array.from({ length: 5 }, () => ({
        assetId: "sol",
        pct: 20,
      }));
      expect(schema.safeParse(broker({ basket })).success).toBe(true);
    });

    it("accepts pct 0 at the schema layer (post-processing drops it, doc 09)", () => {
      // The spec block leaves pct unbounded on purpose: re-normalization is a
      // deterministic server step (guardrail 4), not a validation error.
      const basket = [
        { assetId: "spyx", pct: 0 },
        { assetId: "sol", pct: 100 },
      ];
      expect(schema.safeParse(broker({ basket })).success).toBe(true);
    });

    it("rejects an out-of-tuple asset id — the enum IS the firewall (G11)", () => {
      const basket = [{ assetId: "pepe", pct: 100 }];
      expect(schema.safeParse(broker({ basket })).success).toBe(false);
    });

    it("rejects an unknown cadence", () => {
      expect(
        schema.safeParse(broker({ cadence: "hourly" as never })).success,
      ).toBe(false);
    });
  });

  describe("guardian bounds", () => {
    it.each([[0.5], [0], [91]])("rejects maxDrawdownPct %s", (v) => {
      expect(
        schema.safeParse({ guardian: { maxDrawdownPct: v } }).success,
      ).toBe(false);
    });

    it.each([[1], [90]])("accepts maxDrawdownPct at bound %s", (v) => {
      expect(schema.safeParse({ guardian: { maxDrawdownPct: v } }).success).toBe(
        true,
      );
    });

    it.each([[0], [-10], [5000.01]])("rejects weeklyCapUsd %s", (v) => {
      expect(schema.safeParse({ guardian: { weeklyCapUsd: v } }).success).toBe(
        false,
      );
    });

    it("accepts weeklyCapUsd at the $5000 bound", () => {
      expect(
        schema.safeParse({ guardian: { weeklyCapUsd: 5000 } }).success,
      ).toBe(true);
    });

    it("accepts an empty guardian object (post-processing drops it)", () => {
      expect(schema.safeParse({ guardian: {} }).success).toBe(true);
    });
  });

  describe("legacy bounds", () => {
    const legacy = (over: object) => ({
      legacy: {
        beneficiaryEmail: "ada@example.com",
        inactivityDays: 180,
        ...over,
      },
    });

    it.each([[29], [3651]])("rejects inactivityDays %s", (v) => {
      expect(schema.safeParse(legacy({ inactivityDays: v })).success).toBe(
        false,
      );
    });

    it.each([[30], [3650]])("accepts inactivityDays at bound %s", (v) => {
      expect(schema.safeParse(legacy({ inactivityDays: v })).success).toBe(
        true,
      );
    });

    it("rejects a bad email", () => {
      expect(
        schema.safeParse(legacy({ beneficiaryEmail: "my sister" })).success,
      ).toBe(false);
    });

    it("rejects legacy without an email (required by the schema)", () => {
      expect(
        schema.safeParse({ legacy: { inactivityDays: 180 } }).success,
      ).toBe(false);
    });
  });

  it("strips unknown top-level keys (zod default) — nothing extra survives", () => {
    const parsed = schema.parse({ sendTo: "0xdead", ...broker() });
    expect("sendTo" in parsed).toBe(false);
  });
});
