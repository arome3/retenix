/*
 * Fired the instant a session lands, before the user has finished onboarding.
 *
 * The <60s warm-path budget (PS-F1-AC1) is spent almost entirely on email
 * delivery, so the two slow initializations that follow login are started here
 * and awaited nowhere.
 *
 * Nothing in here may throw or block: a failed warm-up costs latency later, a
 * thrown one costs the user their onboarding.
 */
import { createUa, getAddresses, type UniversalAccount } from "@retenix/ua";
import { warmRegistry } from "@retenix/registry";
import { clientEnv } from "@/env";
import { trpcVanilla } from "@/lib/trpc-vanilla";

/** One UA for this EOA, shared by the two post-login tasks. Browser creds are the NEXT_PUBLIC_PARTICLE_* values. */
function createUniversalAccount(eoa: string): UniversalAccount {
  return createUa({
    ownerAddress: eoa,
    credentials: {
      projectId: clientEnv.NEXT_PUBLIC_PARTICLE_PROJECT_ID,
      projectClientKey: clientEnv.NEXT_PUBLIC_PARTICLE_CLIENT_KEY,
      projectAppUuid: clientEnv.NEXT_PUBLIC_PARTICLE_APP_UUID,
    },
  });
}

/**
 * doc 03: resolve the UA addresses (which also warms the SDK's cached
 * smartAccountOptions) and persist ua_evm_addr / ua_sol_addr onto the users row
 * on first login via account.bootstrap (PROPOSED mechanism — the server
 * re-verifies uaEvm against the session EOA and only the first login writes).
 */
async function bootstrapUniversalAccount(ua: UniversalAccount): Promise<void> {
  const { uaEvm, uaSol } = await getAddresses(ua);
  await trpcVanilla.account.bootstrap.mutate({ uaEvm, uaSol });
}

/**
 * doc 05 (TS-5.6): warm the region-eligible registry so the first buy quote is
 * fast. Pre-gate the region is "" → the full universe warms, which is harmless
 * (warming is a latency cache, not an asset surface). warmRegistry is internally
 * non-fatal (allSettled), but we still guard the call per this file's contract.
 */
async function warmRegistryTokens(ua: UniversalAccount, region: string): Promise<void> {
  await warmRegistry(ua, region);
}

export function onSessionEstablished(eoa: string, region: string): void {
  const ua = createUniversalAccount(eoa);
  void bootstrapUniversalAccount(ua).catch(() => {});
  void warmRegistryTokens(ua, region).catch(() => {});
  // doc 14: silent escrow-tuple refresh on every login — the owner's own
  // activity voids the escrowed set (self-invalidation IS the design), so a
  // fresh session restores inheritance coverage headlessly. Exits after one
  // cheap query when the user isn't enrolled.
  void import("@/lib/escrow").then((m) => m.refreshEscrowCoverage()).catch(() => {});
}
