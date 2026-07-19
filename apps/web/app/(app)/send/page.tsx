import type { Metadata } from "next";
import { SendScreen } from "@/components/SendScreen";
import { requireSession } from "@/server/require-session";

export const metadata: Metadata = { title: "Send" };

// /send (doc 15) — to / amount / confirm; network-free by law (G3).
export default async function Page() {
  const session = await requireSession();
  return <SendScreen eoa={session.eoa} />;
}
