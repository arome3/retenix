import { Magic } from "@magic-sdk/admin";
import { env } from "@/env";

/*
 * The Magic Admin SDK — the only thing that may verify a DID token, and the only
 * consumer of MAGIC_SECRET_KEY. The secret is server-side by construction: it is
 * not a NEXT_PUBLIC_ name, so Next will never inline it into a browser bundle.
 *
 * Magic.init() reaches out to Magic once to resolve the client id, so the handle
 * is memoized. A single import site also gives tests one module to mock.
 */
let admin: Promise<Magic> | null = null;

export function getMagicAdmin(): Promise<Magic> {
  admin ??= Magic.init(env.MAGIC_SECRET_KEY);
  return admin;
}
