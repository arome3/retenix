// Staging-plan rehearsal (doc 08 integration DoD): create a real onchain
// plan, mirror it into Postgres, execute the current period's legs through
// the REAL pipeline in-process, and self-verify the results (recordExecution
// included → UA FINISHED → receipt row with USD amount, ticker, fee total,
// funding sources, and the universalx.app link — PS-F4-AC2).
//
//   pnpm --filter worker rehearse:staging                → $2/day 100% SOL
//   pnpm --filter worker rehearse:staging -- --weekly-basket
//                                                        → $25/week 60-30-10
//                                                          (the DoD shape; needs
//                                                          RETENIX_CONFIRM_SPEND=25
//                                                          — it exceeds the $5/day
//                                                          smoke budget, G7)
//
// The in-process run drives executeJob directly (same code the queue runs);
// the scheduled-cadence variant is simply: leave the worker running and let
// the cron fire at nextRunAt. Module 16's runbook uses both.

import { eq } from "drizzle-orm";
import { executions, jobs } from "@retenix/db";
import { activityUrl } from "@retenix/ua";
import { PgBoss } from "pg-boss";

import { env } from "../env";
import { executeJob, type ExecutorDeps } from "../src/executor";
import { getPool } from "@retenix/db";
import { enqueuePlanNow } from "../src/scheduler";
import { executeLegForUser } from "../src/ua-exec";
import {
  DAILY_SOL,
  WEEKLY_BASKET,
  buildRig,
  createStagingPlan,
  ownerAction,
  particleReady,
  policyReady,
} from "./lib";

async function main(): Promise<number> {
  const weekly = process.argv.includes("--weekly-basket");
  const spec = weekly ? WEEKLY_BASKET : DAILY_SOL;

  if (!particleReady() || !policyReady()) {
    ownerAction("rehearse-staging", [
      "set real PARTICLE_* credentials and the deployed POLICY_CONTRACT_ADDRESS in apps/worker/.env",
    ]);
  }
  if (weekly && process.env.RETENIX_CONFIRM_SPEND !== "25") {
    ownerAction("rehearse-staging", [
      "the $25 weekly basket exceeds the $5/day smoke budget (G7) — export RETENIX_CONFIRM_SPEND=25 to confirm the demo-window spend (module 16 runbook item)",
    ]);
  }

  const rig = await buildRig("rehearse-staging");
  const { planId, contractPlanId, userId } = await createStagingPlan(rig, spec);

  const boss = new PgBoss(env.DATABASE_URL);
  await boss.start();
  await boss.createQueue("execute", { policy: "exclusive" });

  const deps: ExecutorDeps = {
    db: rig.db,
    boss,
    policy: rig.policy,
    uaForLeg: (plan, leg) => executeLegForUser(plan, leg, rig.agent),
    lockPool: getPool(),
    demoMode: env.DEMO_MODE === "1",
  };

  const enqueued = await enqueuePlanNow({ db: rig.db, boss }, planId);
  if ("error" in enqueued) {
    console.error(`[rehearse-staging] enqueue failed: ${enqueued.error}`);
    return 1;
  }
  console.log(
    `[rehearse-staging] period ${enqueued.periodStartIso} → ${enqueued.jobIds.length} leg job(s); executing through the real pipeline…`,
  );

  let failures = 0;
  for (const jobId of enqueued.jobIds) {
    await executeJob(deps, { jobId });
    const [row] = await rig.db
      .select()
      .from(executions)
      .where(eq(executions.jobId, jobId))
      .orderBy(executions.createdAt);
    const [job] = await rig.db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!row) {
      console.error(`[rehearse-staging] job ${jobId}: NO execution row`);
      failures += 1;
      continue;
    }
    const qj = row.quoteJson as {
      policy?: { record?: { txHash?: string } };
    } | null;
    console.log(`\n[leg ${jobId}]`);
    console.log(`  status:   execution=${row.status} job=${job.status}`);
    console.log(`  receipt:  ${row.receiptText}`);
    if (qj?.policy?.record?.txHash) {
      console.log(`  record:   https://arbiscan.io/tx/${qj.policy.record.txHash}`);
    }
    if (row.uaTxId) console.log(`  activity: ${activityUrl(row.uaTxId)}`);
    console.log(`  fees:     ${JSON.stringify(row.feesJson)}`);

    // Self-verification (PS-F4-AC2): amount, ticker, fee total, sources, link.
    const ok =
      row.status === "finished" &&
      job.status === "done" &&
      /^Bought \$\d/.test(row.receiptText) &&
      row.receiptText.includes("funded from") &&
      row.receiptText.includes("fees $") &&
      row.receiptText.endsWith("· view onchain") &&
      typeof row.uaTxId === "string" &&
      row.uaTxId.length > 0 &&
      row.feesJson != null &&
      qj?.policy?.record?.txHash != null;
    if (!ok) {
      console.error("  VERIFY:   FAILED (see fields above)");
      failures += 1;
    } else {
      console.log("  VERIFY:   OK — recordExecution included → UA FINISHED → receipt complete");
    }
  }

  await boss.stop({ graceful: false, timeout: 5_000 }).catch(() => undefined);
  console.log(
    `\n[rehearse-staging] plan ${planId} (onchain #${contractPlanId}, user ${userId}) — ${enqueued.jobIds.length - failures}/${enqueued.jobIds.length} legs verified`,
  );
  if (failures === 0 && !weekly) {
    console.log(
      "[rehearse-staging] scheduled-cadence variant: leave the worker running; the cron executes the next period at the plan's nextRunAt (kill it mid-poll to rehearse resume — see scripts/README.md)",
    );
  }
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[rehearse-staging] error:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
