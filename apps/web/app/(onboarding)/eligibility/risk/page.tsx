import type { Metadata } from "next";
import { RiskStep } from "./RiskStep";

export const metadata: Metadata = { title: "One thing to confirm" };

// C12 step 4 (doc 04): the risk acknowledgment. On confirm the gate finalizes
// (compliance.acknowledgeRisk writes users.region) and the user reaches S1's
// "Your account is ready".
export default function RiskPage() {
  return <RiskStep />;
}
