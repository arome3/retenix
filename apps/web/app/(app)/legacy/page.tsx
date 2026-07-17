import { LegacyScreen } from "@/components/LegacyScreen";
import { requireSession } from "@/server/require-session";

// S5 · Legacy (doc 14) — enrollment wizard + enrolled state.
export default async function Page() {
  const session = await requireSession();
  return <LegacyScreen eoa={session.eoa} />;
}
