// S3 · Agents (doc 10). Server shell hands the session EOA to the client
// roster; the gate/session are already enforced by (app)/layout.tsx.
import { AgentsScreen } from "@/components/AgentsScreen";
import { requireSession } from "@/server/require-session";

export default async function AgentsPage() {
  const { eoa } = await requireSession();
  return <AgentsScreen eoa={eoa} />;
}
