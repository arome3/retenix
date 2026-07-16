import { KillSurface } from "@/components/KillSwitch";
import { requireSession } from "@/server/require-session";

// S2's header shield-slash tap lands here (C7, doc 13). The hold IS the
// confirmation — no further dialog exists by design (TS-14.5).
export default async function KillPage() {
  const session = await requireSession();
  return <KillSurface eoa={session.eoa} region={session.region} />;
}
