// The ONE sanctioned regional filter for the asset universe (doc 04 §failure
// modes: "a second ad-hoc filter WILL drift"). Never expose an unfiltered
// convenience list to UI callers — every asset surface (docs 06/10/12/13) filters
// through here.
//
// `isAssetEligibleInRegion` is module 04's helper, built in @retenix/shared for
// exactly this. It is provably identical to doc 05's inline expression:
//   REGISTRY.filter(a => a.eligibleRegions === "ALL" || !EQUITY_RESTRICTED_REGIONS.includes(region))
// but keeps the eligibility predicate defined once, in the compliance module.
import { isAssetEligibleInRegion } from "@retenix/shared";
import { REGISTRY, type RegistryAsset } from "./assets";

/**
 * The SECOND, orthogonal dimension (doc 18 F11). Region says *where* an asset
 * may be sold; this says *to whom*.
 *
 * Leverage appropriateness is a property of the USER (did they answer the decay
 * question?), not of the region, so it deliberately does NOT become a fourth
 * `AssetEligibility` value — that union is a pure region function with no user
 * in scope, and overloading it would be a category error.
 */
export interface AssetAccess {
  /** Set from `isLeverageUnlocked(storedQuizAnswers)`. DEFAULTS FALSE — every
   *  call site keeps compiling and stays FAIL-CLOSED until reviewed, so a
   *  forgotten caller hides leveraged assets rather than exposing them. */
  leveragedUnlocked?: boolean;
}

const LEVERAGED_KINDS: ReadonlySet<string> = new Set(["leveraged"]);

export function eligibleAssets(
  region: string,
  access: AssetAccess = {},
): readonly RegistryAsset[] {
  return REGISTRY.filter((a) => {
    if (!isAssetEligibleInRegion(a.eligibleRegions, region)) return false;
    if (LEVERAGED_KINDS.has(a.kind)) return access.leveragedUnlocked === true;
    return true;
  });
}
