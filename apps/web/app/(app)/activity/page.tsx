import type { Metadata } from "next";
import { ActivityScreen } from "@/components/ActivityScreen";
import { requireSession } from "@/server/require-session";

// S4 · Activity (doc 11) — server shell: the layout already gates the region;
// requireSession here is the authoritative re-check (module 02's invariant).
// All data rides the session cookie through trpc in the client screen.
export const metadata: Metadata = { title: "Activity" };

export default async function ActivityPage() {
  await requireSession();
  return <ActivityScreen />;
}
