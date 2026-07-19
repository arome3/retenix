import { pgTable, uuid, text, timestamp, jsonb, integer, bigint, doublePrecision, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";

export const planKind = pgEnum("plan_kind", ["broker", "guardian", "legacy"]);
export const planStatus = pgEnum("plan_status", ["draft", "active", "paused", "revoked"]);
export const jobStatus = pgEnum("job_status", ["pending", "running", "done", "failed", "skipped"]);
export const executionStatus = pgEnum("execution_status", [
  "quoted", "recorded", "submitted", "finished", "refunded", "blocked", "failed",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  emailHash: text("email_hash").notNull().unique(),   // sha256(lowercase email) — raw email never stored here
  eoaAddr: text("eoa_addr").notNull().unique(),
  uaEvmAddr: text("ua_evm_addr").notNull(),
  uaSolAddr: text("ua_sol_addr").notNull(),
  region: text("region").notNull(),                   // ISO 3166-1 alpha-2 (doc 04)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const plans = pgTable("plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  kind: planKind("kind").notNull(),
  paramsJson: jsonb("params_json").notNull(),          // PolicyDraft slice for this card (doc 09)
  contractPlanId: bigint("contract_plan_id", { mode: "number" }), // null for legacy (estate) & P1 guardian triggers
  status: planStatus("status").notNull().default("draft"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
});

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id").notNull().references(() => plans.id),
  runAt: timestamp("run_at", { withTimezone: true }).notNull(),   // ALL timestamps UTC (TS-7.2)
  periodKey: text("period_key").notNull(),             // `${planId}:${periodStart}:${seq}` idempotency (doc 08)
  status: jobStatus("status").notNull().default("pending"),
  attempt: integer("attempt").notNull().default(0),
},
(t) => [uniqueIndex("jobs_period_key_uq").on(t.periodKey)]);

export const executions = pgTable("executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  uaTxId: text("ua_tx_id"),                            // Particle transactionId; null if blocked pre-send
  quoteJson: jsonb("quote_json"),
  feesJson: jsonb("fees_json"),                        // parsed fee totals (doc 03 parseFeeTotals)
  status: executionStatus("status").notNull(),
  receiptText: text("receipt_text").notNull(),         // deterministic sentence (doc 08) — NEVER LLM
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const estates = pgTable("estates", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  contractStateCache: jsonb("contract_state_cache"),   // mirrored Estate struct + status
  beneficiaryEmailEnc: text("beneficiary_email_enc").notNull(), // KMS-envelope ciphertext (doc 14)
  tuplesEnc: text("tuples_enc"),                       // encrypted escrowed 7702 tuples (doc 14)
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
});

// PROPOSED (spec-silent) — doc 12: hourly portfolio valuation snapshots written by the
// worker cron; power C11 chart ranges and C10 sparklines. NOT part of tech-spec §12's
// core schema (doc 00 records it as a doc-12 extension); product-owner review by W3.
// total_usd/per_asset_json carry display-only marks — nothing prices an execution here.
export const portfolioSnapshots = pgTable("portfolio_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  totalUsd: doublePrecision("total_usd").notNull(),
  perAssetJson: jsonb("per_asset_json").notNull(),     // { [assetId]: { qty, markUsd, valueUsd, stale? } }
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
},
(t) => [index("portfolio_snapshots_user_at_idx").on(t.userId, t.at)]);

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  type: text("type").notNull(),                        // e.g. sweep.receipt, estate.checkin, kill.leg
  payloadJson: jsonb("payload_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
},
// Module 17: this table had NO indexes and is the busiest read in the app.
// It backs the activity feed, the signed-route nonce check (every signed
// mutation), assertGatePassed (every gated request), the estate claim-email
// freshness check, and now the PS-8.2 idempotency guards. The spec'd schema
// (doc 00 / tech spec §12) declares no indexes; these are additive and change
// no column.
(t) => [
  index("events_type_created_idx").on(t.type, t.createdAt),
  index("events_user_type_idx").on(t.userId, t.type),
  // A functional index on payload_json->>'sid' was tried and REMOVED: with
  // `type` in the predicate the planner picks events_type_created_idx and
  // applies the sid as a filter (verified with EXPLAIN), so the extra index
  // would cost a write on every events insert — and events is written on every
  // signed mutation — to serve a read nothing uses.
]);
