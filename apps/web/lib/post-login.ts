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
import { createUa, getAddresses } from "@retenix/ua";
import { clientEnv } from "@/env";
import { trpcVanilla } from "@/lib/trpc-vanilla";

/**
 * doc 03: construct the Universal Account for this EOA, resolve its addresses (which
 * also warms the SDK's cached smartAccountOptions), and persist ua_evm_addr /
 * ua_sol_addr onto the users row on first login via account.bootstrap (PROPOSED
 * mechanism — the server re-verifies uaEvm against the session EOA and only the first
 * login writes). Browser creds are the NEXT_PUBLIC_PARTICLE_* values.
 */
async function warmUniversalAccount(eoa: string): Promise<void> {
  const ua = createUa({
    ownerAddress: eoa,
    credentials: {
      projectId: clientEnv.NEXT_PUBLIC_PARTICLE_PROJECT_ID,
      projectClientKey: clientEnv.NEXT_PUBLIC_PARTICLE_CLIENT_KEY,
      projectAppUuid: clientEnv.NEXT_PUBLIC_PARTICLE_APP_UUID,
    },
  });
  const { uaEvm, uaSol } = await getAddresses(ua);
  await trpcVanilla.account.bootstrap.mutate({ uaEvm, uaSol });
}

/** TODO(doc 05): warmUpToken() over the launch asset set. */
async function warmUpToken(): Promise<void> {}

export function onSessionEstablished(eoa: string): void {
  void warmUniversalAccount(eoa).catch(() => {});
  void warmUpToken().catch(() => {});
}
