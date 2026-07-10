import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EligibilityGateSlot } from "@/components/EligibilityGateSlot";
import { devAffordances } from "@/env";
import { requireSession } from "@/server/require-session";

export const metadata: Metadata = { title: "One quick check" };

// S1.3 (DS-S1): the eligibility gate stands between sign-in and any asset
// screen. Doc 04 owns what happens inside it; this route owns where it stands.
export default async function EligibilityPage() {
  const user = await requireSession({ requireRegion: false });
  if (user.region) redirect("/ready");

  return <EligibilityGateSlot devPassthrough={devAffordances} />;
}
