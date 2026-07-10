import { getDb, users } from "@retenix/db";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSession } from "./session";

/*
 * The authoritative gate (doc 02). proxy.ts routes on cookie presence because it
 * runs where the database does not; this verifies the HMAC and re-reads
 * users.region, so a hand-forged retenix_gate never survives a page render.
 *
 * Region is read from the row, not the cookie: doc 04 may change it out from
 * under a session that is still valid.
 */
export type AuthedUser = {
  userId: string;
  eoa: string;
  issuer: string;
  region: string;
};

/** Clears a session whose user no longer exists, rather than bouncing forever. */
const STALE_SESSION = "/api/session/end";

export async function requireSession(
  { requireRegion = true }: { requireRegion?: boolean } = {},
): Promise<AuthedUser> {
  const session = await getSession();
  if (!session) redirect("/welcome");

  const [row] = await getDb()
    .select({ region: users.region })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  if (!row) redirect(STALE_SESSION);

  // "" is the sentinel for "the eligibility gate has not run" (doc 04).
  if (requireRegion && !row.region) redirect("/eligibility");

  return {
    userId: session.userId,
    eoa: session.eoa,
    issuer: session.issuer,
    region: row.region,
  };
}
