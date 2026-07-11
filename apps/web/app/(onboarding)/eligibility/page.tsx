import { redirect } from "next/navigation";

// S1.3 (DS-S1). The gate stands between sign-in and any asset screen. The layout
// forwards a user who has already finished the gate; the proxy and requireSession
// send a region-less session here, so this entry just starts step 1. Region → quiz
// → identity → risk, one route per step (DS-C12).
export default function EligibilityPage() {
  redirect("/eligibility/region");
}
