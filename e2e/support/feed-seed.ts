import { randomUUID } from "node:crypto";
import { dbQuery, type TestUser } from "./session";

/*
 * Feed-row seeding for module 11's specs — inserts the same rows the worker
 * (executions via plans→jobs) and the web routers (events) write, so the
 * activity feed renders REAL stored sentences through the real route.
 * Cleanup rides deleteTestUser/sweepTestUsers (FK-ordered there).
 */

/** Valid broker params (module 08's brokerParamsSchema shape) — RosterCard
 *  derives terms from these, so they must be well-formed for /agents. */
export const BROKER_PARAMS = {
  cadence: "weekly",
  amountUsd: 25,
  basket: [{ assetId: "spyx", pct: 100 }],
  capPerExecUsd: 25,
  capPerPeriodUsd: 50,
  periodSecs: 604_800,
  nextRunAt: "2026-07-23T12:00:00.000Z",
  autonomy: "auto",
  topUpOptIn: false,
} as const;

export async function seedPlan(
  user: TestUser,
  opts: {
    kind?: "broker" | "guardian" | "legacy";
    status?: "draft" | "active" | "paused" | "revoked";
    params?: unknown;
  } = {},
): Promise<string> {
  const { rows } = await dbQuery<{ id: string }>(
    `insert into plans (user_id, kind, params_json, status, activated_at)
     values ($1, $2, $3, $4, now()) returning id`,
    [
      user.userId,
      opts.kind ?? "broker",
      JSON.stringify(opts.params ?? BROKER_PARAMS),
      opts.status ?? "active",
    ],
  );
  return rows[0].id;
}

export async function seedJob(planId: string): Promise<string> {
  const { rows } = await dbQuery<{ id: string }>(
    `insert into jobs (plan_id, run_at, period_key, status)
     values ($1, now(), $2, 'done') returning id`,
    [planId, `${planId}:e2e:${randomUUID()}`],
  );
  return rows[0].id;
}

export interface ExecutionSeed {
  status:
    | "quoted"
    | "recorded"
    | "submitted"
    | "finished"
    | "refunded"
    | "blocked"
    | "failed";
  receiptText: string;
  createdAt?: Date;
  uaTxId?: string | null;
  feesJson?: unknown;
  quoteJson?: unknown;
}

export async function seedExecution(
  jobId: string,
  seed: ExecutionSeed,
): Promise<string> {
  const { rows } = await dbQuery<{ id: string }>(
    `insert into executions
       (job_id, status, receipt_text, created_at, ua_tx_id, fees_json, quote_json)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      jobId,
      seed.status,
      seed.receiptText,
      seed.createdAt ?? new Date(),
      seed.uaTxId ?? null,
      seed.feesJson === undefined ? null : JSON.stringify(seed.feesJson),
      seed.quoteJson === undefined ? null : JSON.stringify(seed.quoteJson),
    ],
  );
  return rows[0].id;
}

export async function seedEvent(
  user: TestUser,
  type: string,
  payload: unknown,
  createdAt?: Date,
): Promise<string> {
  const { rows } = await dbQuery<{ id: string }>(
    `insert into events (user_id, type, payload_json, created_at)
     values ($1, $2, $3, $4) returning id`,
    [user.userId, type, JSON.stringify(payload), createdAt ?? new Date()],
  );
  return rows[0].id;
}

/** A ready-to-block/execute plan+job pair in one call. */
export async function seedPlanWithJob(
  user: TestUser,
): Promise<{ planId: string; jobId: string }> {
  const planId = await seedPlan(user);
  const jobId = await seedJob(planId);
  return { planId, jobId };
}
