import { describe, expect, it } from "vitest";
import { REGISTRY } from "./assets";
import { eligibleAssets } from "./eligible";

describe("eligibleAssets (the one sanctioned regional filter, doc 04)", () => {
  it("a restricted region (US/CA/GB/AU) sees only crypto — SOL + ETH", () => {
    for (const region of ["US", "CA", "GB", "AU"]) {
      const eligible = eligibleAssets(region);
      expect(
        eligible.every((a) => a.kind === "crypto"),
        `${region} leaked a non-crypto asset`,
      ).toBe(true);
      expect(eligible.map((a) => a.id).sort()).toEqual(["eth", "sol"]);
    }
  });

  it("no equity ever leaks into a blocked region (the 'US sees SPYx' bug)", () => {
    for (const region of ["US", "CA", "GB", "AU"]) {
      expect(eligibleAssets(region).filter((a) => a.kind === "equity")).toHaveLength(0);
    }
  });

  it("a non-restricted region (DE, NG) sees the full registry", () => {
    for (const region of ["DE", "NG"]) {
      expect(eligibleAssets(region)).toEqual(REGISTRY);
    }
  });

  it("matches the verbatim doc-04 filter expression exactly", () => {
    const RESTRICTED = ["US", "CA", "GB", "AU"];
    const verbatim = (region: string) =>
      REGISTRY.filter(
        (a) => a.eligibleRegions === "ALL" || !RESTRICTED.includes(region),
      );
    for (const region of ["US", "CA", "GB", "AU", "DE", "NG", "JP", ""]) {
      expect(eligibleAssets(region)).toEqual(verbatim(region));
    }
  });
});
