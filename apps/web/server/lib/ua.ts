import { createUa, type UniversalAccount } from "@retenix/ua";
import { clientEnv } from "@/env";

/*
 * Server-side UA factory (doc 06). The web server constructs a UA for the
 * session user to READ balances and QUOTE sells — it can never sign for them
 * (the key lives in Magic's TEE; signatures happen in the browser via
 * magicSigner). Credentials are the NEXT_PUBLIC_PARTICLE_* trio: doc 00's
 * canonical web env carries only those Particle names, and they are public by
 * design (the browser ships them in the bundle) — reading clientEnv on the
 * server adds no secret surface.
 */
export function serverUa(ownerAddress: string): UniversalAccount {
  return createUa({
    ownerAddress,
    credentials: {
      projectId: clientEnv.NEXT_PUBLIC_PARTICLE_PROJECT_ID,
      projectClientKey: clientEnv.NEXT_PUBLIC_PARTICLE_CLIENT_KEY,
      projectAppUuid: clientEnv.NEXT_PUBLIC_PARTICLE_APP_UUID,
    },
  });
}
