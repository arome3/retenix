import { Wallet } from "ethers";
import cron from "node-cron";
import { PgBoss } from "pg-boss";
import { warmRegistry } from "@retenix/registry";
import { createUa } from "@retenix/ua";
import { env } from "../env";

// doc 05 (TS-5.6): warm the registry asset set at boot to cut first-quote
// latency. Non-blocking and non-fatal — warming is a latency optimization only.
//
// The worker's real agent identity is KMS-signed (doc 08); until that lands,
// only the dev AGENT_EOA_PRIVATE_KEY path can construct a UA. No key → skip.
// doc 08 keeps this call site and swaps in the KMS-owned UA.
async function warmRegistryAtBoot(): Promise<void> {
  if (!env.AGENT_EOA_PRIVATE_KEY) {
    console.log(
      "[worker] registry warm-up skipped — no AGENT_EOA_PRIVATE_KEY (doc 08 wires the KMS agent UA)",
    );
    return;
  }
  try {
    const ua = createUa({
      ownerAddress: new Wallet(env.AGENT_EOA_PRIVATE_KEY).address,
      credentials: {
        projectId: env.PARTICLE_PROJECT_ID,
        projectClientKey: env.PARTICLE_CLIENT_KEY,
        projectAppUuid: env.PARTICLE_APP_UUID,
      },
    });
    // The worker is not region-bound — it may execute any user's plan — so it
    // warms the COMPLETE tradeable universe. eligibleAssets() returns the full
    // set for any non-restricted region; "" (no region) is the honest "not a
    // user" value. Warming is never an asset surface, so the permissive
    // isEquityEligible("") behavior is intended here, not a leak.
    await warmRegistry(ua, "");
    console.log("[worker] registry warm-up dispatched");
  } catch (err) {
    console.warn(
      "[worker] registry warm-up failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// Boot: cron + pg-boss workers. Module 08 fills in the handlers.
async function main() {
  const boss = new PgBoss(env.DATABASE_URL);
  boss.on("error", (err: Error) => console.error("[worker] pg-boss error", err));
  await boss.start();

  // Per-minute due-plan scan cadence (module 08 implements the handler).
  const scan = cron.schedule("* * * * *", () => {});

  console.log("[worker] booted — cron scheduled, pg-boss started");

  // Fire-and-forget; boot readiness must not wait on quote warming.
  void warmRegistryAtBoot();

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received — shutting down`);
    scan.stop();
    await boss.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] boot failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
