// Rogue-instruction rehearsal (doc 08 integration DoD; demo beat 5): POST
// /internal/demo/rogue against a RUNNING worker and assert the blocked
// receipt lands within seconds — the $500 memecoin attempt travels the real
// queue → executor → staticCall gate and fails AT THE CONTRACT (expected
// OverExecCap for $500 vs a $50/exec cap; doc 07's check order).
//
// Run: worker up with DEMO_MODE=1, then
//   STAGING_PLAN_ID=<plans.id> pnpm --filter worker rehearse:rogue
// Optional: WORKER_URL (default http://127.0.0.1:8080).

import { eq } from "drizzle-orm";
import { executions, getDb, jobs } from "@retenix/db";

import { env } from "../env";
import { ownerAction } from "./lib";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  const base = process.env.WORKER_URL ?? "http://127.0.0.1:8080";
  const planId = process.env.STAGING_PLAN_ID;
  if (!planId) {
    ownerAction("rehearse-rogue", [
      "set STAGING_PLAN_ID to an active broker plans.id (create one with rehearse:staging)",
      `worker must be RUNNING with DEMO_MODE=1 at ${base}`,
    ]);
  }

  try {
    const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3_000) });
    if (!health.ok) throw new Error(`healthz ${health.status}`);
  } catch {
    ownerAction("rehearse-rogue", [
      `worker not reachable at ${base} — start it (pnpm --filter worker dev) with DEMO_MODE=1`,
    ]);
  }

  const started = Date.now();
  const res = await fetch(`${base}/internal/demo/rogue`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.INTERNAL_API_TOKEN}`,
    },
    body: JSON.stringify({ planId }),
  });
  if (res.status === 404) {
    ownerAction("rehearse-rogue", [
      "the rogue endpoint 404'd — the worker is not running with DEMO_MODE=1 (it must not exist otherwise), or the plan id is unknown",
    ]);
  }
  if (res.status !== 202) {
    console.error(`[rehearse-rogue] unexpected ${res.status}: ${await res.text()}`);
    return 1;
  }
  const { jobId, periodKey } = (await res.json()) as { jobId: string; periodKey: string };
  console.log(`[rehearse-rogue] enqueued rogue job ${jobId} (${periodKey})`);

  const db = getDb();
  for (let waited = 0; waited < 30_000; waited += 1_000) {
    const [row] = await db
      .select()
      .from(executions)
      .where(eq(executions.jobId, jobId));
    if (row) {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
      console.log(`[rehearse-rogue] receipt after ${secs}s: "${row.receiptText}" (execution=${row.status}, job=${job.status})`);
      const ok =
        row.status === "blocked" &&
        row.receiptText.startsWith("Blocked:") &&
        job.status === "done";
      console.log(
        ok
          ? "[rehearse-rogue] OK — out-of-policy attempt blocked at the contract, receipt within seconds (PS-F5-AC1 surface)"
          : "[rehearse-rogue] VERIFY FAILED — expected a blocked receipt",
      );
      return ok ? 0 : 1;
    }
    await sleep(1_000);
  }
  console.error("[rehearse-rogue] no execution row within 30s — is the worker consuming the queue?");
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[rehearse-rogue] error:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
