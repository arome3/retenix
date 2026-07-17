import type { Metadata } from "next";
import { WithdrawScreen } from "@/components/WithdrawScreen";
import { requireSession } from "@/server/require-session";

export const metadata: Metadata = { title: "Withdraw" };

// /send/withdraw (doc 15) — asset → address → "Where should it arrive?"
// (CONFLICTS #16: the single sanctioned network-choice surface).
export default async function Page() {
  const session = await requireSession();
  return <WithdrawScreen eoa={session.eoa} />;
}
