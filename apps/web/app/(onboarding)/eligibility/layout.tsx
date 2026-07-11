import { redirect } from "next/navigation";
import { requireSession } from "@/server/require-session";

/*
 * The eligibility gate (C12, doc 04) — every step nests under this guard.
 *
 * A user who has already completed the gate (users.region is set) must never
 * re-enter it: a refresh, a back-button, or a bookmarked step forwards to
 * /ready. Loop-safe — /ready is not a gate route and requireSession() passes for
 * a region-set user. requireRegion:false so a mid-gate (region-less) session is
 * allowed through to the steps rather than bounced back here by the proxy.
 */
export default async function EligibilityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireSession({ requireRegion: false });
  if (user.region) redirect("/ready");
  return <>{children}</>;
}
