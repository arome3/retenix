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

export function eligibleAssets(region: string): readonly RegistryAsset[] {
  return REGISTRY.filter((a) => isAssetEligibleInRegion(a.eligibleRegions, region));
}
