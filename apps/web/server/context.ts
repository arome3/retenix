import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { getDb, type Db } from "@retenix/db";

export type Session = {
  userId: string;
  eoaAddr: string;
};

export type Context = {
  db: Db;
  session: Session | null;
  headers: Headers;
};

// Session is a stub until module 02 implements Magic session-cookie
// verification; every protectedProcedure call is UNAUTHORIZED until then.
export async function createContext(
  opts: FetchCreateContextFnOptions,
): Promise<Context> {
  return {
    db: getDb(),
    session: null,
    headers: opts.req.headers,
  };
}
