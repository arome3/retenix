import type { Metadata } from "next";
import { RegionStep } from "./RegionStep";

export const metadata: Metadata = { title: "Where are you investing from?" };

// C12 step 1 (doc 04). Country select with a hard block on tokenized equities for
// restricted regions — which continues into the crypto-basket experience, not a
// dead end. The region model + immutability live server-side (compliance.setRegion).
export default function RegionPage() {
  return <RegionStep />;
}
