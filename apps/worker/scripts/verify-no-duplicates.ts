// Idempotency verifier for the kill/resume rehearsal (doc 08 DoD: "killing
// the worker mid-run and restarting causes zero duplicate buys"). For a
// plan, group executions by leg (period_key) and assert: at most ONE
// distinct ua_tx_id per leg, at most one finished row per leg, and at most
// one non-empty receipt per leg.
//
// Run: STAGING_PLAN_ID=<plans.id> pnpm --filter worker verify:nodup

import { eq } from "drizzle-orm";
import { executions, getDb, jobs } from "@retenix/db";

import { ownerAction } from "./lib";

async function main(): Promise<number> {
  const planId = process.env.STAGING_PLAN_ID;
  if (!planId) {
    ownerAction("verify-nodup", ["set STAGING_PLAN_ID to the plans.id under test"]);
  }
  const db = getDb();
  const legRows = await db
    .select({
      jobId: jobs.id,
      periodKey: jobs.periodKey,
      jobStatus: jobs.status,
      execStatus: executions.status,
      uaTxId: executions.uaTxId,
      receiptText: executions.receiptText,
    })
    .from(jobs)
    .leftJoin(executions, eq(executions.jobId, jobs.id))
    .where(eq(jobs.planId, planId as string));

  const byLeg = new Map<
    string,
    { uaTxIds: Set<string>; finished: number; receipts: number; jobStatus: string }
  >();
  for (const r of legRows) {
    const leg = byLeg.get(r.periodKey) ?? {
      uaTxIds: new Set<string>(),
      finished: 0,
      receipts: 0,
      jobStatus: r.jobStatus,
    };
    if (r.uaTxId) leg.uaTxIds.add(r.uaTxId);
    if (r.execStatus === "finished") leg.finished += 1;
    if (r.receiptText && r.receiptText.length > 0) leg.receipts += 1;
    byLeg.set(r.periodKey, leg);
  }

  let bad = 0;
  for (const [periodKey, leg] of byLeg) {
    const ok = leg.uaTxIds.size <= 1 && leg.finished <= 1 && leg.receipts <= 1;
    console.log(
      `${ok ? "OK " : "DUP"}  ${periodKey}  ua_tx_ids=${leg.uaTxIds.size} finished=${leg.finished} receipts=${leg.receipts} job=${leg.jobStatus}`,
    );
    if (!ok) bad += 1;
  }
  console.log(
    bad === 0
      ? `\n[verify-nodup] OK — ${byLeg.size} leg(s), zero duplicate sends/receipts`
      : `\n[verify-nodup] FAILED — ${bad} leg(s) show duplicates`,
  );
  return bad === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[verify-nodup] error:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
