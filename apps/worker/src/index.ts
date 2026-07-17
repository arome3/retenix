// Worker boot (doc 08): env-validate (../env, at import) → agent signer
// (KMS or dev wallet) → contract-agent assertion → pg-boss (exclusive
// queue) → executor worker → node-cron per-minute scheduler → internal
// HTTP → registry warm-up → graceful shutdown (finish in-flight, stop
// fetching). Scheduling is node-cron + pg-boss ONLY (G9 — Gelato Web3
// Functions shut down 2026-03-31; Vercel cron unusable).

import cron from "node-cron";
import { PgBoss } from "pg-boss";
import { getDb, getPool } from "@retenix/db";
import { warmRegistry } from "@retenix/registry";

import { createUa, getTransactions } from "@retenix/ua";

import { env } from "../env";
import { EXECUTE_QUEUE } from "./ctx";
import { executeJob, type ExecutorDeps } from "./executor";
import {
  getWorkerEscrowProvider,
  PolicyEstateClient,
} from "./estate-support";
import {
  HEARTBEAT_CRON_DEMO,
  HEARTBEAT_CRON_PROD,
  heartbeatTick,
  observeOwner,
  type HeartbeatDeps,
} from "./heartbeat";
import { startHttp } from "./http";
import { defaultKeeperDeps, KEEPER_CRON_DEMO, KEEPER_CRON_PROD, keeperTick, type KeeperDeps } from "./keeper";
import { getAgentSigner, type AgentSigner } from "./kms";
import { captureError, initSentry } from "./notify";
import { PolicyClient } from "./policy";
import { rescueOrphans, scanDuePlans } from "./scheduler";
import { snapshotTick } from "./snapshots";
import { agentUaFor, executeLegForUser } from "./ua-exec";

/**
 * The deployed contract's `agent` is immutable — a mismatched signer would
 * revert NotAgent on every recordExecution. Mismatch is fatal with the fix
 * spelled out; an unreachable RPC only warns (per-job calls surface it).
 */
async function assertAgentMatchesContract(
  policy: PolicyClient,
  agentAddress: string,
): Promise<void> {
  let onchainAgent: string;
  try {
    onchainAgent = await policy.contractAgent();
  } catch (err) {
    captureError(err, { source: "agent-assert" });
    console.warn(
      "[worker] could not verify the contract agent at boot (RPC unreachable?) — continuing; per-job calls will surface failures",
    );
    return;
  }
  if (onchainAgent.toLowerCase() !== agentAddress.toLowerCase()) {
    throw new Error(
      `agent mismatch: RetenixPolicy at ${env.POLICY_CONTRACT_ADDRESS} expects agent ${onchainAgent}, our signer is ${agentAddress} — every recordExecution would revert NotAgent. ` +
        `Fix (doc 07/08 runbook, ~$0.30): redeploy with AGENT_ADDRESS=${agentAddress} via contracts/script/Deploy.s.sol, then update POLICY_CONTRACT_ADDRESS, packages/shared/src/contracts.ts and docs/deployments.md.`,
    );
  }
  console.log(`[worker] agent signer matches the contract agent (${onchainAgent})`);
}

// doc 05 (TS-5.6): warm the tradeable universe at boot to cut first-quote
// latency. Non-blocking and non-fatal — warming is a latency optimization.
// The worker is not region-bound ("" = the honest "not a user" value).
async function warmRegistryAtBoot(agent: AgentSigner): Promise<void> {
  try {
    await warmRegistry(agentUaFor(agent), "");
    console.log("[worker] registry warm-up dispatched");
  } catch (err) {
    console.warn(
      "[worker] registry warm-up failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function main(): Promise<void> {
  initSentry();

  // Agent signer: dev wallet or KMS. Placeholder credentials (fresh clone,
  // doc 00's boot story) degrade the boot instead of killing it — cron,
  // queue and HTTP stay live; execution jobs fail loudly until credentials
  // exist. A resolved-but-MISMATCHED agent is still fatal (see the assert).
  let agent: AgentSigner | null = null;
  let policy: PolicyClient | null = null;
  try {
    agent = await getAgentSigner();
    policy = new PolicyClient({
      rpcUrl: env.RPC_URL_ARBITRUM,
      address: env.POLICY_CONTRACT_ADDRESS,
      signer: agent.ethSigner,
    });
    await assertAgentMatchesContract(policy, agent.address);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("agent mismatch")) throw err;
    if (env.NODE_ENV === "production") throw err; // prod never runs degraded
    agent = null;
    policy = null;
    captureError(err, { source: "agent-signer-boot" });
    console.warn(
      "[worker] DEGRADED boot — no usable agent signer (set AGENT_EOA_PRIVATE_KEY for dev, or AWS KMS credentials). Scheduler/HTTP are live; execution jobs will fail until credentials exist.",
    );
  }

  const db = getDb();
  const demoMode = env.DEMO_MODE === "1";

  const boss = new PgBoss(env.DATABASE_URL);
  // Pre-existing toolchain quirk (2026-07-13): under `tsc -b` composite
  // builds pg-boss v12's `extends EventEmitter<PgBossEventMap>` base
  // collapses and the instance loses inherited members; the intersection
  // restores the EventEmitter surface without changing runtime behavior.
  (boss as PgBoss & NodeJS.EventEmitter).on("error", (err: Error) =>
    captureError(err, { source: "pg-boss" }),
  );
  await boss.start();

  // Policy `exclusive` is MANDATORY: the default `standard` policy has no
  // singleton index, so singletonKey would deduplicate nothing (verified
  // against pg-boss 12.25.1 internals). Retry settings here are the CRASH
  // ladder only — the business ladder (30s/2m/10m, refund-first) lives in
  // the executor. expireInSeconds must exceed the 30-min in-handler poll;
  // heartbeats give ~1-min dead-worker detection instead of 15–45.
  await boss.createQueue(EXECUTE_QUEUE, {
    policy: "exclusive",
    retryLimit: 3,
    retryDelay: 15,
    expireInSeconds: 2_700,
    heartbeatSeconds: 60,
  });

  const execDeps: ExecutorDeps | null =
    agent && policy
      ? {
          db,
          boss,
          policy,
          uaForLeg: (plan, leg) => executeLegForUser(plan, leg, agent),
          lockPool: getPool(),
          demoMode,
        }
      : null;
  await boss.work<{ jobId: string }>(
    EXECUTE_QUEUE,
    { batchSize: 1, localConcurrency: 8, heartbeatRefreshSeconds: 15 },
    async ([job]) => {
      if (!execDeps) {
        throw new Error(
          "agent signer unavailable (degraded boot) — provide AGENT_EOA_PRIVATE_KEY or AWS KMS credentials and restart",
        );
      }
      await executeJob(execDeps, job.data);
    },
  );

  const schedulerCtx = { db, boss };
  const tick = async (): Promise<void> => {
    try {
      await scanDuePlans(schedulerCtx);
      await rescueOrphans(schedulerCtx);
    } catch (err) {
      captureError(err, { source: "cron-tick" });
    }
  };
  const scan = cron.schedule("* * * * *", () => void tick(), { noOverlap: true });

  // Hourly portfolio snapshots (doc 12, PROPOSED) — display-only valuation
  // rows for C11/C10. Plain cron body, no queue: a missed tick is an honest
  // chart gap, never something to retry into existence after the fact.
  const snapTick = async (): Promise<void> => {
    try {
      await snapshotTick({ db });
    } catch (err) {
      captureError(err, { source: "snapshot-cron" });
    }
  };
  const snapshots = cron.schedule("0 * * * *", () => void snapTick(), {
    noOverlap: true,
  });
  // Boot kick: dev/demo environments get chart points without waiting for
  // the top of the hour (readiness must not wait on it — fire and forget).
  void snapTick();

  // --- estate crons (doc 14) — heartbeat observation + keeper. Both need a
  // signer (relayer/keeper identity = the agent signer on the current role
  // wiring); a degraded boot skips them with the same warning posture.
  let heartbeatDeps: HeartbeatDeps | null = null;
  let keeperDeps: KeeperDeps | null = null;
  let heartbeatCron: ReturnType<typeof cron.schedule> | null = null;
  let keeperCron: ReturnType<typeof cron.schedule> | null = null;
  if (agent) {
    const estateOnchain = new PolicyEstateClient(agent.ethSigner);
    heartbeatDeps = {
      db,
      onchain: estateOnchain,
      observer: {
        // per-owner UA (read-only — no signer): the cross-network activity feed
        recentActivity: (owner) =>
          getTransactions(
            createUa({
              ownerAddress: owner,
              credentials: {
                projectId: env.PARTICLE_PROJECT_ID,
                projectClientKey: env.PARTICLE_CLIENT_KEY,
                projectAppUuid: env.PARTICLE_APP_UUID,
              },
            }),
          ),
      },
    };
    try {
      keeperDeps = defaultKeeperDeps(db, estateOnchain, getWorkerEscrowProvider(), agent.ethSigner);
    } catch (err) {
      captureError(err, { source: "escrow-provider-boot" });
      console.warn(
        "[worker] estate keeper disabled — no escrow provider (set ESCROW_DEV_SECRET for dev, or AWS KMS credentials)",
      );
    }
    const hb = heartbeatDeps;
    heartbeatCron = cron.schedule(
      demoMode ? HEARTBEAT_CRON_DEMO : HEARTBEAT_CRON_PROD,
      () => void heartbeatTick(hb).catch((err) => captureError(err, { source: "heartbeat-cron" })),
      { noOverlap: true },
    );
    if (keeperDeps) {
      const kd = keeperDeps;
      keeperCron = cron.schedule(
        demoMode ? KEEPER_CRON_DEMO : KEEPER_CRON_PROD,
        () => void keeperTick(kd).catch((err) => captureError(err, { source: "keeper-cron" })),
        { noOverlap: true },
      );
    }
  } else {
    console.warn("[worker] estate heartbeat/keeper disabled (degraded boot — no signer)");
  }

  const server = startHttp({
    db,
    boss,
    demoMode,
    estateWebhook: {
      db,
      // immediate observation on webhook match — UX freshness only
      observe: heartbeatDeps ? (estate) => observeOwner(heartbeatDeps, estate) : undefined,
    },
  });

  // Fire-and-forget; boot readiness must not wait on quote warming.
  if (agent) void warmRegistryAtBoot(agent);

  console.log(
    `[worker] booted — agent ${agent ? `${agent.address} (${agent.kind})` : "UNAVAILABLE (degraded)"}, queue "${EXECUTE_QUEUE}" (exclusive), cron per-minute, http :${env.PORT}${demoMode ? ", DEMO_MODE" : ""}`,
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(
      `[worker] ${signal} received — graceful shutdown (finish in-flight job, stop fetching)`,
    );
    scan.stop();
    snapshots.stop();
    heartbeatCron?.stop();
    keeperCron?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      // Waits for the in-flight handler; a >60s poll is failed into pg-boss
      // retry and resumes at its persisted state (submitted → poll-only).
      await boss.stop({ graceful: true, timeout: 60_000 });
    } catch (err) {
      captureError(err, { source: "boss.stop" });
    }
    await getPool()
      .end()
      .catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    captureError(reason, { source: "unhandledRejection" });
  });
}

main().catch((err) => {
  console.error("[worker] boot failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
