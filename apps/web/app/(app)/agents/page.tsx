// S3 · Agents (doc 10). Server shell hands the session EOA to the client
// roster; the gate/session are already enforced by (app)/layout.tsx.
// ?prefill= seeds the intent bar (doc 12's Buy-more path, PROPOSED wording
// recorded in HANDOFF) — length-capped to the intent.parse input bound and
// never auto-submitted; the user edits or sends it like their own words.
import { AgentsScreen } from "@/components/AgentsScreen";
import { requireSession } from "@/server/require-session";

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ prefill?: string | string[] }>;
}) {
  const { eoa } = await requireSession();
  const { prefill } = await searchParams;
  const initialIntent =
    typeof prefill === "string" ? prefill.slice(0, 200) : undefined;
  return <AgentsScreen eoa={eoa} initialIntent={initialIntent} />;
}
