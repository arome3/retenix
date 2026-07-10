import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { getDb, type Db } from "@retenix/db";
import { shouldRefresh } from "@/lib/session";
import { readSession, setSessionCookie } from "./session";

export type Session = {
  userId: string;
  eoaAddr: string;
  /** Magic DID the token was minted for. */
  issuer: string;
  /** ISO 3166-1 alpha-2, or "" until the eligibility gate runs (doc 04). */
  region: string;
};

export type Context = {
  db: Db;
  session: Session | null;
  headers: Headers;
  /** Procedures mint and clear the session cookie through these (doc 02). */
  resHeaders: Headers;
};

// The session is an HMAC-signed cookie issued by auth.magicCallback once a DID
// token has been verified server-side (doc 02). protectedProcedure gates on its
// presence; signedProcedure additionally recovers a fresh personal_sign from
// session.eoaAddr.
export async function createContext(
  opts: FetchCreateContextFnOptions,
): Promise<Context> {
  const verified = await readSession(opts.req.headers);

  // Seven-day sliding expiry — an active user is never logged out mid-use.
  if (verified && shouldRefresh(verified.issuedAt)) {
    await setSessionCookie({ resHeaders: opts.resHeaders }, verified);
  }

  return {
    db: getDb(),
    session: verified
      ? {
          userId: verified.userId,
          eoaAddr: verified.eoa,
          issuer: verified.issuer,
          region: verified.region,
        }
      : null,
    headers: opts.req.headers,
    resHeaders: opts.resHeaders,
  };
}
