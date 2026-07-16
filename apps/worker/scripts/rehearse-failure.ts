// Forced-UA-failure rehearsal (doc 08 integration DoD): a corrupted root
// signature makes Particle reject every send, so a real staging leg walks
// the honest failure ladder — refundExecution BEFORE each retry, then the
// eventual failed-refunded receipt — against mainnet, without moving funds
// (only recordExecution/refundExecution gas).
//
// Run (both env vars are required, deliberately explicit):
//   DEMO_MODE=1 FAULT_INJECT_UA=corrupt-root-sig pnpm --filter worker rehearse:failure
//
// The ladder's 30s/2m/10m pacing lives in pg-boss startAfter scheduling and
// is unit-tested; this rehearsal drives the attempts back-to-back (the
// state machine treats each invocation as the janitor/queue would) so the
// whole ladder lands in minutes, with every refund tx printed for Arbiscan.

import { eq } from "drizzle-orm";
import { executions, getPool, jobs } from "@retenix/db";
import { PgBoss } from "pg-boss";

import { env } from "../env";
import { MAX_RETRIES, executeJob, type ExecutorDeps } from "../src/executor";
import { enqueuePlanNow } from "../src/scheduler";
import { executeLegForUser } from "../src/ua-exec";
import {
  DAILY_SOL,
  buildRig,
  createStagingPlan,
  ownerAction,
  particleReady,
  policyReady,
} from "./lib";

async function main(): Promise<number> {
  if (env.DEMO_MODE !== "1" || env.FAULT_INJECT_UA !== "corrupt-root-sig") {
    ownerAction("rehearse-failure", [
      "run with DEMO_MODE=1 FAULT_INJECT_UA=corrupt-root-sig (the fault injection is double-gated on purpose)",
    ]);
  }
  if (!particleReady() || !policyReady()) {
    ownerAction("rehearse-failure", [
      "set real PARTICLE_* credentials and the deployed POLICY_CONTRACT_ADDRESS in apps/worker/.env",
    ]);
  }

  const rig = await buildRig("rehearse-failure");
  const { planId } = await createStagingPlan(rig, DAILY_SOL);

  const boss = new PgBoss(env.DATABASE_URL);
  await boss.start();
  await boss.createQueue("execute", { policy: "exclusive" });
  const deps: ExecutorDeps = {
    db: rig.db,
    boss,
    policy: rig.policy,
    uaForLeg: (plan, leg) => executeLegForUser(plan, leg, rig.agent),
    lockPool: getPool(),
    demoMode: true,
  };

  const enqueued = await enqueuePlanNow({ db: rig.db, boss }, planId);
  if ("error" in enqueued) {
    console.error(`[rehearse-failure] enqueue failed: ${enqueued.error}`);
    return 1;
  }
  const jobId = enqueued.jobIds[0];

  // Attempt 1 + MAX_RETRIES retries, driven back-to-back.
  for (let run = 1; run <= MAX_RETRIES + 1; run += 1) {
    console.log(`\n[rehearse-failure] pipeline run ${run}/${MAX_RETRIES + 1}`);
    await executeJob(deps, { jobId });
    const rows = await rig.db
      .select()
      .from(executions)
      .where(eq(executions.jobId, jobId))
      .orderBy(executions.createdAt);
    const last = rows[rows.length - 1];
    const qj = last.quoteJson as {
      policy?: { record?: { txHash?: string }; refund?: { txHash?: string } };
      cause?: string;
    } | null;
    console.log(
      `  attempt rows=${rows.length} last.status=${last.status} cause=${qj?.cause ?? "-"}`,
    );
    if (qj?.policy?.record?.txHash) {
      console.log(`  record: https://arbiscan.io/tx/${qj.policy.record.txHash}`);
    }
    if (qj?.policy?.refund?.txHash) {
      console.log(`  refund: https://arbiscan.io/tx/${qj.policy.refund.txHash} (BEFORE the retry — TS-6.5)`);
    } else if (last.status !== "failed") {
      console.error("  MISSING refund intent — the ladder must refund before retrying");
      return 1;
    }
  }

  const rows = await rig.db
    .select()
    .from(executions)
    .where(eq(executions.jobId, jobId))
    .orderBy(executions.createdAt);
  const [job] = await rig.db.select().from(jobs).where(eq(jobs.id, jobId));
  const final = rows[rows.length - 1];
  console.log(`\n[rehearse-failure] final receipt: "${final.receiptText}" (job ${job.status})`);

  const ok =
    rows.length === MAX_RETRIES + 1 &&
    final.receiptText.startsWith("Didn't complete — your ") &&
    final.receiptText.endsWith("was returned") &&
    job.status === "skipped";
  if (!ok) {
    console.error("[rehearse-failure] VERIFY FAILED — expected one row per attempt and the failed-refunded receipt");
  } else {
    console.log(
      `[rehearse-failure] OK — ${rows.length} attempts, refund before every retry, eventual failed-refunded receipt, Slack fired on each step (check the channel)`,
    );
    console.log(
      "[rehearse-failure] note: attempts were driven back-to-back; the 30s/2m/10m pacing is pg-boss startAfter scheduling, unit-tested in executor.test.ts",
    );
  }
  await boss.stop({ graceful: false, timeout: 5_000 }).catch(() => undefined);
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[rehearse-failure] error:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
