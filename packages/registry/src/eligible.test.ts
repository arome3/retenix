import { describe, expect, it } from "vitest";
import { REGISTRY } from "./assets";
import { eligibleAssets } from "./eligible";

describe("eligibleAssets (the one sanctioned regional filter, doc 04/20)", () => {
  it("an equity-restricted region (US/CA/GB/AU) sees crypto + gold, never equities", () => {
    for (const region of ["US", "CA", "GB", "AU"]) {
      const eligible = eligibleAssets(region);
      // Doc 20 US-fallback upgrade: crypto (SOL/ETH) + gold (PAXG), no equities.
      expect(eligible.map((a) => a.id).sort()).toEqual(["eth", "paxg", "sol"]);
      expect(
        eligible.every((a) => a.kind === "crypto" || a.kind === "rwa-gold"),
        `${region} leaked an equity`,
      ).toBe(true);
    }
  });

  it("no equity ever leaks into a blocked region (the 'US sees SPYx' bug)", () => {
    for (const region of ["US", "CA", "GB", "AU"]) {
      expect(eligibleAssets(region).filter((a) => a.kind === "equity")).toHaveLength(0);
    }
  });

  it("a sanctioned region (IR/KP/CU/SY) is denied gold specifically", () => {
    // Honest composed semantics (flagged for the compliance owner in HANDOFF):
    // equities ride the separate US/CA/GB/AU list, so a sanctioned region not in
    // those four still sees equities — the NON_SANCTIONED tier withholds ONLY
    // gold. Module 20 owns gold's gate; equity-sanction gating is doc 04's call.
    for (const region of ["IR", "KP", "CU", "SY"]) {
      const eligible = eligibleAssets(region);
      expect(eligible.some((a) => a.kind === "rwa-gold")).toBe(false);
      expect(eligible.map((a) => a.id)).not.toContain("paxg");
      expect(eligible.some((a) => a.kind === "crypto")).toBe(true);
    }
  });

  it("a non-restricted region (DE, NG) sees the full registry", () => {
    for (const region of ["DE", "NG"]) {
      expect(eligibleAssets(region)).toEqual(REGISTRY);
    }
  });

  it("matches the verbatim doc-04/20 filter expression exactly (three tiers)", () => {
    const RESTRICTED = ["US", "CA", "GB", "AU"];
    const SANCTIONED = ["CU", "IR", "KP", "SY"];
    const verbatim = (region: string) =>
      REGISTRY.filter((a) => {
        if (a.eligibleRegions === "ALL") return true;
        if (a.eligibleRegions === "NON_SANCTIONED")
          return !SANCTIONED.includes(region);
        return !RESTRICTED.includes(region); // NON_RESTRICTED
      });
    for (const region of ["US", "CA", "GB", "AU", "DE", "NG", "JP", "IR", "KP", ""]) {
      expect(eligibleAssets(region)).toEqual(verbatim(region));
    }
  });
});
