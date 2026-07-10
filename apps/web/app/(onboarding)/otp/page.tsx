import type { Metadata } from "next";
import { OtpFlow } from "./OtpFlow";

export const metadata: Metadata = { title: "Check your email" };

// S1.2 (DS-S1): the code entry itself is Magic's, rendered over this screen.
// Everything the user reads while they wait is ours, and it stays honest —
// nothing here claims progress that is not happening.
export default function OtpPage() {
  return (
    <div className="flex min-h-[80dvh] flex-col justify-center gap-8 py-12">
      <OtpFlow />
    </div>
  );
}
