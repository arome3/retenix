import { ClaimFlow } from "@/components/claim/ClaimFlow";
import { getSession } from "@/server/session";

// S6 heir claim — public, token-gated (module 14). The layout forces
// paper-light (doc 01); the flow is the demo's Finale B.
export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await getSession();
  return <ClaimFlow token={token} sessionEoa={session?.eoa ?? null} />;
}
