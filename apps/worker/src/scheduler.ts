// Due-plan scan → per-leg jobs (doc 08 §Idempotency & queue).
//
// Idempotency layering (in order of authority):
//   1. jobs.period_key `${planId}:${periodStartIso}:${seq}` + the doc-00
//      unique index — INSERT … ON CONFLICT DO NOTHING is the law.
//   2. pg-boss singletonKey under the queue's `exclusive` policy — an
//      unconditional (re)send resolves null when a queued/active twin
//      exists, which makes crash recovery a plain re-run of the scan.
//   3. The executor's per-leg advisory lock + executions state machine.
//
// nextRunAt advances AFTER insert+send, via a jsonb_set CAS on the previous
// value: a crash before the advance re-enters this scan harmlessly (1+2),
// and two racing scheduler instances cannot double-advance (the second CAS
// misses). Missed periods roll past WITHOUT catch-up buys — stacking N
// periods of purchases is not what the user scheduled.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { jobs, plans } from "@retenix/db";
import {
  advanceSchedule,
  brokerParamsSchema,
  periodOf,
  type BrokerPlanParams,
} from "@retenix/shared";

import { computeLegs } from "./basket";
import { EXECUTE_QUEUE, type BossLike } from "./ctx";
import { captureError, recordEvent, slack } from "./notify";
import type { Db } from "@retenix/db";

export interface SchedulerCtx {
  db: Db;
  boss: BossLike;
}

interface DuePlanRow {
  id: string;
  userId: string;
  paramsJson: unknown;
  activatedAt: Date | null;
  contractPlanId: number | null;
}

export const buildPeriodKey = (
  planId: string,
  periodStartIso: string,
  seq: number,
): string => `${planId}:${periodStartIso}:${seq}`;

/** Rogue jobs carry their marker in period_key — the only crash-durable
 *  field under the frozen schema (a rescued job must keep its rogue-ness). */
export const isRoguePeriodKey = (periodKey: string): boolean =>
  periodKey.includes(":rogue:");

// One log per malformed plan per boot — the scan runs every minute and a
// broken row must not turn the log into a firehose.
const invalidParamsLogged = new Set<string>();
export const __resetSchedulerLogDedupe = (): void => {
  invalidParamsLogged.clear();
};

/** Cron entry point: every minute, UTC. */
export async function scanDuePlans(ctx: SchedulerCtx, now: Date = new Date()): Promise<void> {
  const due = (await ctx.db
    .select({
      id: plans.id,
      userId: plans.userId,
      paramsJson: plans.paramsJson,
      activatedAt: plans.activatedAt,
      contractPlanId: plans.contractPlanId,
    })
    .from(plans)
    .where(
      and(
        eq(plans.kind, "broker"),
        eq(plans.status, "active"),
        isNotNull(plans.contractPlanId),
        sql`(${plans.paramsJson}->>'nextRunAt')::timestamptz <= ${now.toISOString()}::timestamptz`,
      ),
    )) as DuePlanRow[];

  for (const plan of due) {
    try {
      await schedulePlanPeriod(ctx, plan, now, { advance: true });
    } catch (err) {
      captureError(err, { while: "scanDuePlans", planId: plan.id });
    }
  }
}

function parsePlan(plan: DuePlanRow): BrokerPlanParams | null {
  const parsed = brokerParamsSchema.safeParse(plan.paramsJson);
  if (parsed.success && plan.activatedAt && plan.contractPlanId != null) {
    return parsed.data;
  }
  if (!invalidParamsLogged.has(plan.id)) {
    invalidParamsLogged.add(plan.id);
    captureError(new Error(`plan ${plan.id}: params_json failed the broker read-contract`), {
      issues: parsed.success ? "missing activatedAt/contractPlanId" : parsed.error.issues,
    });
  }
  return null;
}

/**
 * Insert the current period's legs (idempotent) and (re)send their queue
 * jobs (singleton-null-safe). Shared by the cron scan and execute-now.
 */
async function schedulePlanPeriod(
  ctx: SchedulerCtx,
  plan: DuePlanRow,
  now: Date,
  opts: { advance: boolean },
): Promise<{ jobIds: string[]; periodStartIso: string } | null> {
  const params = parsePlan(plan);
  if (!params) {
    await recordEvent(ctx.db, "plan.params_invalid", plan.userId, { planId: plan.id });
    return null;
  }

  // Scheduler-side period identity anchors to activation; the executor
  // re-reads the CONTRACT's periodStart for cap math (that one is law).
  const anchorSec = Math.floor((plan.activatedAt as Date).getTime() / 1000);
  const nowSec = Math.floor(now.getTime() / 1000);
  const { periodStart } = periodOf(
    { periodStart: anchorSec, periodSecs: params.periodSecs },
    nowSec,
  );
  const periodStartIso = new Date(periodStart * 1000).toISOString();

  const legs = computeLegs(params);
  const runAt = opts.advance ? new Date(params.nextRunAt) : now;
  await ctx.db
    .insert(jobs)
    .values(
      legs.map((leg) => ({
        planId: plan.id,
        runAt,
        periodKey: buildPeriodKey(plan.id, periodStartIso, leg.seq),
        status: "pending" as const,
      })),
    )
    .onConflictDoNothing({ target: jobs.periodKey });

  // (Re)send every non-terminal job of the period — crash between insert
  // and send self-heals here; twins resolve to null under `exclusive`.
  const keys = legs.map((leg) => buildPeriodKey(plan.id, periodStartIso, leg.seq));
  const periodJobs = await ctx.db
    .select({ id: jobs.id, periodKey: jobs.periodKey, status: jobs.status })
    .from(jobs)
    .where(inArray(jobs.periodKey, keys));
  const live = periodJobs.filter((j) => j.status === "pending" || j.status === "running");
  for (const job of live) {
    await ctx.boss.send(EXECUTE_QUEUE, { jobId: job.id }, { singletonKey: job.periodKey });
  }

  if (opts.advance) {
    const prevIso = params.nextRunAt;
    const { next, missed } = advanceSchedule(
      params.cadence,
      plan.activatedAt as Date,
      new Date(prevIso),
      now,
    );
    const updated = await ctx.db
      .update(plans)
      .set({
        paramsJson: sql`jsonb_set(${plans.paramsJson}, '{nextRunAt}', to_jsonb(${next.toISOString()}::text))`,
      })
      .where(and(eq(plans.id, plan.id), sql`${plans.paramsJson}->>'nextRunAt' = ${prevIso}`))
      .returning({ id: plans.id });
    if (updated.length > 0 && missed > 0) {
      await recordEvent(ctx.db, "plan.periods_missed", plan.userId, {
        planId: plan.id,
        missed,
        resumedAt: now.toISOString(),
      });
      await slack(
        `:warning: plan ${plan.id}: ${missed} scheduled period(s) missed while the worker was down — resumed without catch-up buys`,
      );
    }
  }

  return { jobIds: live.map((j) => j.id), periodStartIso };
}

/**
 * POST /internal/execute-now — enqueue the CURRENT period's legs
 * immediately (plans.activate's optional "run first buy now" + demo
 * tooling). Reuses the idempotent path: a period that already ran is a
 * no-op, so this can never double-buy. nextRunAt is untouched.
 */
export async function enqueuePlanNow(
  ctx: SchedulerCtx,
  planId: string,
  now: Date = new Date(),
): Promise<{ jobIds: string[]; periodStartIso: string } | { error: string }> {
  const [plan] = (await ctx.db
    .select({
      id: plans.id,
      userId: plans.userId,
      paramsJson: plans.paramsJson,
      activatedAt: plans.activatedAt,
      contractPlanId: plans.contractPlanId,
    })
    .from(plans)
    .where(
      and(eq(plans.id, planId), eq(plans.kind, "broker"), eq(plans.status, "active")),
    )) as DuePlanRow[];
  if (!plan) return { error: "plan not found, not a broker plan, or not active" };
  const result = await schedulePlanPeriod(ctx, plan, now, { advance: false });
  return result ?? { error: "plan params_json failed validation" };
}

/**
 * POST /internal/demo/rogue — a deliberately out-of-policy attempt routed
 * through the REAL pipeline (DEMO_MODE only; the executor recognizes the
 * :rogue: marker, skips quote/preflight — no quote exists for a fake asset
 * — and must fail at step 4, onchain). $500 vs a $50/exec cap reverts
 * OverExecCap (doc 07's check order); a $30 variant demos AssetNotAllowed.
 */
export async function enqueueRogue(
  ctx: SchedulerCtx,
  planId: string,
): Promise<{ jobId: string; periodKey: string } | { error: string }> {
  const [plan] = await ctx.db
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.kind, "broker")));
  if (!plan) return { error: "plan not found" };
  const periodKey = `${planId}:rogue:${randomUUID()}`;
  const [row] = await ctx.db
    .insert(jobs)
    .values({ planId, runAt: new Date(), periodKey, status: "pending" })
    .returning({ id: jobs.id });
  await ctx.boss.send(EXECUTE_QUEUE, { jobId: row.id }, { singletonKey: periodKey });
  return { jobId: row.id, periodKey };
}

/**
 * Janitor (every cron tick): re-send the base singleton key for any
 * non-terminal job that has been quiet longer than the deepest business
 * backoff (10 min < threshold) — rescues jobs whose queue twin was lost
 * (crash between insert/send, pg-boss dead-`failed` after crash retries,
 * lost retry sends). Twins make it a no-op; the executor's advisory lock
 * makes a rare double harmless. Resurrections are bounded via events
 * (the frozen schema has no counter column).
 */
const RESCUE_QUIET_MS = 15 * 60 * 1000;
const MAX_RESURRECTIONS = 5;

export async function rescueOrphans(ctx: SchedulerCtx, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - RESCUE_QUIET_MS);
  const stuck = await ctx.db
    .select({ id: jobs.id, periodKey: jobs.periodKey, planId: jobs.planId })
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, ["pending", "running"]),
        sql`${jobs.runAt} <= ${cutoff.toISOString()}::timestamptz`,
        // Quiet: no execution row created since the cutoff.
        sql`NOT EXISTS (SELECT 1 FROM executions e WHERE e.job_id = ${jobs.id} AND e.created_at > ${cutoff.toISOString()}::timestamptz)`,
      ),
    );

  for (const job of stuck) {
    try {
      const counted = (await ctx.db.execute(
        sql`SELECT count(*)::int AS count FROM events WHERE type = 'job.resurrected' AND payload_json->>'jobId' = ${job.id}`,
      )) as unknown as { rows: { count: number }[] };
      const count = Number(counted.rows?.[0]?.count ?? 0);
      if (count >= MAX_RESURRECTIONS) {
        await ctx.db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, job.id));
        await recordEvent(ctx.db, "job.rescue_exhausted", null, {
          jobId: job.id,
          planId: job.planId,
          periodKey: job.periodKey,
        });
        await slack(
          `:rotating_light: job ${job.id} (${job.periodKey}) exhausted ${MAX_RESURRECTIONS} rescues — marked failed; needs a human`,
        );
        continue;
      }
      await recordEvent(ctx.db, "job.resurrected", null, {
        jobId: job.id,
        periodKey: job.periodKey,
        attempt: count + 1,
      });
      await ctx.boss.send(EXECUTE_QUEUE, { jobId: job.id }, { singletonKey: job.periodKey });
    } catch (err) {
      captureError(err, { while: "rescueOrphans", jobId: job.id });
    }
  }
}
