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

/** doc 12: one portfolio_snapshots row — the worker cron's exact shape. */
export async function seedSnapshot(
  user: TestUser,
  seed: {
    totalUsd: number;
    perAsset?: Record<
      string,
      { qty: number; markUsd: number; valueUsd: number; stale?: boolean }
    >;
    at: Date;
  },
): Promise<void> {
  await dbQuery(
    `insert into portfolio_snapshots (user_id, total_usd, per_asset_json, at)
     values ($1, $2, $3, $4)`,
    [user.userId, seed.totalUsd, JSON.stringify(seed.perAsset ?? {}), seed.at],
  );
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

/** The mixed three-class demo basket (doc 20 beat 3): equity + gold + crypto. */
export const MIXED_BASKET_PARAMS = {
  cadence: "weekly",
  amountUsd: 25,
  basket: [
    { assetId: "spyx", pct: 60 },
    { assetId: "paxg", pct: 20 },
    { assetId: "sol", pct: 20 },
  ],
  capPerExecUsd: 15,
  capPerPeriodUsd: 25,
  periodSecs: 604_800,
  nextRunAt: "2026-07-23T12:00:00.000Z",
  autonomy: "auto",
  topUpOptIn: false,
} as const;

/**
 * Seed a FINISHED tokenized-gold (PAXG) buy so the demo/e2e holds gold (doc 20).
 * The `quote_json.fill` is what the holdings route + snapshot cron read to
 * attribute basis and enumerate the position (HANDOFF §12) — an empty quote_json
 * would render as an unattributed buy with basis suppressed. Module 16's demo
 * seed uses this so /home shows a gold row with its disclosure line.
 */
export async function seedGoldHolding(
  user: TestUser,
  opts: { usd?: number; qty?: number; createdAt?: Date } = {},
): Promise<{ planId: string; jobId: string; executionId: string }> {
  const usd = opts.usd ?? 5;
  const qty = opts.qty ?? 0.00125; // ~$5 of gold at ~$4000/oz
  const planId = await seedPlan(user, { params: MIXED_BASKET_PARAMS });
  const jobId = await seedJob(planId);
  const executionId = await seedExecution(jobId, {
    status: "finished",
    receiptText: `Bought $${usd.toFixed(2)} of PAXG · funded from Ethereum · fees $0.00 · view onchain`, // copy-canon-allow
    uaTxId: `demo-paxg-${randomUUID()}`,
    feesJson: { gas: 0, service: 0, lp: 0, total: 0 },
    quoteJson: { fill: { assetId: "paxg", usd, qty } },
    createdAt: opts.createdAt,
  });
  return { planId, jobId, executionId };
}
