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

  it("a non-restricted region (DE, NG) sees the full registry once leverage is unlocked", () => {
    for (const region of ["DE", "NG"]) {
      expect(eligibleAssets(region, { leveragedUnlocked: true })).toEqual(REGISTRY);
    }
  });

  it("leveraged assets are FAIL-CLOSED: an eligible region without the unlock sees none", () => {
    // doc 18 F11 — the appropriateness gate. Region alone is never enough.
    for (const region of ["DE", "NG", "JP"]) {
      const locked = eligibleAssets(region);
      expect(locked.some((a) => a.kind === "leveraged")).toBe(false);
      // ...and everything else is untouched by the new dimension.
      expect(locked.map((a) => a.id)).toEqual(
        REGISTRY.filter((a) => a.kind !== "leveraged").map((a) => a.id),
      );
    }
  });

  it("the unlock never overrides region: a restricted region sees no leveraged asset even unlocked", () => {
    // The two dimensions are AND-ed, not OR-ed. Shift's own terms exclude
    // US/UK, and NON_RESTRICTED (US/CA/GB/AU) is stricter still.
    for (const region of ["US", "CA", "GB", "AU"]) {
      const unlocked = eligibleAssets(region, { leveragedUnlocked: true });
      expect(unlocked.some((a) => a.kind === "leveraged")).toBe(false);
      expect(unlocked.map((a) => a.id).sort()).toEqual(["eth", "paxg", "sol"]);
    }
  });

  it("matches the verbatim doc-04/18/20 filter expression exactly (three tiers × the leverage gate)", () => {
    const RESTRICTED = ["US", "CA", "GB", "AU"];
    const SANCTIONED = ["CU", "IR", "KP", "SY"];
    const verbatim = (region: string, leveragedUnlocked: boolean) =>
      REGISTRY.filter((a) => {
        const regionOk =
          a.eligibleRegions === "ALL"
            ? true
            : a.eligibleRegions === "NON_SANCTIONED"
              ? !SANCTIONED.includes(region)
              : !RESTRICTED.includes(region); // NON_RESTRICTED
        if (!regionOk) return false;
        if (a.kind === "leveraged") return leveragedUnlocked; // doc 18 F11
        return true;
      });
    for (const region of ["US", "CA", "GB", "AU", "DE", "NG", "JP", "IR", "KP", ""]) {
      for (const unlocked of [false, true]) {
        expect(
          eligibleAssets(region, { leveragedUnlocked: unlocked }),
          `${region} unlocked=${unlocked}`,
        ).toEqual(verbatim(region, unlocked));
      }
      // The default argument must be the fail-closed branch, not merely
      // equivalent to it by accident.
      expect(eligibleAssets(region)).toEqual(verbatim(region, false));
    }
  });
});
