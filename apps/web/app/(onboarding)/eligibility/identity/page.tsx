import type { Metadata } from "next";
import { IdentityStep } from "./IdentityStep";

export const metadata: Metadata = { title: "Your details" };

// C12 step 3 (doc 04): a simulated identity step, labeled as such (PS-10.4). Never
// claims KYC — real KYC is out of scope. The entered name/DOB are not persisted.
export default function IdentityPage() {
  return <IdentityStep />;
}
