// ENS resolution (doc 15) — viem mainnet READ-ONLY client over the canonical
// RPC_URL_ETHEREUM, 5 s hard timeout, miss/timeout/error → null (the UI's
// "name not found"). Resolution runs at form-preview time AND again inside
// send.execute's authorize phase (the server re-validates at execute time —
// a stale preview can never become the transfer target).
//
// Deps-injected (the dust.ts pattern) so unit tests cover hit/miss/timeout
// without a network.
import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet } from "viem/chains"; // copy-canon-allow (viem's subpath, not user copy)
import { normalize } from "viem/ens";

import { env } from "@/env";

/** Doc 15: "viem mainnet client (read-only) with 5 s timeout". */
export const ENS_TIMEOUT_MS = 5_000;

export interface EnsDeps {
  getEnsAddress(args: { name: string }): Promise<string | null>;
}

let client: PublicClient | null = null;
function defaultDeps(): EnsDeps {
  client ??= createPublicClient({
    chain: mainnet,
    transport: http(env.RPC_URL_ETHEREUM, { timeout: ENS_TIMEOUT_MS }),
  });
  return client;
}

/** Cheap syntactic gate: "looks like an ENS name" (dot-separated labels,
 *  ending in a TLD-ish label). The real validation is normalize() + the
 *  registry lookup — this only routes form input to the ENS path. */
export function looksLikeEnsName(value: string): boolean {
  const v = value.trim();
  if (!v.includes(".") || v.includes("@") || v.startsWith("0x")) return false;
  return /^[^\s.]+(\.[^\s.]+)+$/.test(v);
}

/**
 * Resolve an ENS name to its address. Null on: invalid name (normalize
 * throws), no resolution, RPC error, or the 5 s ceiling — every failure is
 * the same honest "name not found" (doc 15; a send to an unresolved
 * recipient must never proceed).
 */
export async function resolveEnsName(
  name: string,
  deps: EnsDeps = defaultDeps(),
): Promise<string | null> {
  let normalized: string;
  try {
    normalized = normalize(name.trim());
  } catch {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Promise-level ceiling on top of the transport timeout: the fallback
    // must hold even for injected/misbehaving transports.
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ENS_TIMEOUT_MS);
    });
    const address = await Promise.race([
      deps.getEnsAddress({ name: normalized }),
      timeout,
    ]);
    return typeof address === "string" && address.length > 0 ? address : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
