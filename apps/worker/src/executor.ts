// The 7-step execution pipeline (doc 08; tech spec §7 — the law of this
// service), implemented as a crash-resumable state machine over the
// executions table:
//
//   1 read plan state from contract   → view call (status, caps)
//   2 createBuyTransaction quote      → persisted BEFORE anything signs
//   3 preflight (courtesy)            → caps in usd6, registry+region (G11),
//                                       slippage sanity, buying power
//   4 recordExecution onchain         → staticCall gate first (blocked
//                                       receipts within seconds); write-ahead
//                                       intent; INCLUDED before step 5
//   5 re-read status, then UA send    → never after a revoke, even if 4 landed
//   6 poll to terminal → receipt row  → deterministic sentences only
//   7 failure → refundExecution FIRST → retry 30s/2m/10m → skip-and-notify
//
// At-most-once machinery (each layer independent):
//   - per-leg Postgres advisory lock (twin pg-boss jobs → one runner)
//   - executions state machine: statuses only move forward per attempt row;
//     every external side effect (record tx, UA send, refund tx) persists
//     its evidence BEFORE firing, and every resume branch reconciles
//     evidence instead of re-firing
//   - UA send-evidence probe: the create-time transactionId is on disk
//     before signing; a `recorded` resume probes it before ever re-sending
//
// Business failures NEVER throw (they are handled: refund → retry ladder →
// skip-and-notify; nothing silent). Throwing is reserved for infra faults,
// which pg-boss retries as crash recovery.

import { desc, eq } from "drizzle-orm";
import { executions, jobs, plans, users, type Db } from "@retenix/db";
import { REGISTRY, assetIdHash, eligibleAssets } from "@retenix/registry";
import {
  blockedReceipt,
  brokerParamsSchema,
  capText,
  effectiveSpent,
  executedReceipt,
  networkName,
  refundedReceipt,
  revokedReceipt,
  skippedReceipt,
  toUsd6,
  unresolvedReceipt,
  type BlockReason,
  type BrokerPlanParams,
} from "@retenix/shared";
import {
  activityUrl,
  parseFeeTotals,
  type FeeTotalsUSD,
  type ITransaction,
} from "@retenix/ua";

import { computeLegs, type BasketLeg } from "./basket";
import { EXECUTE_QUEUE, RETRY_BACKOFF_SECS, type BossLike } from "./ctx";
import { breadcrumb, captureError, recordEvent, slack } from "./notify";
import {
  PLAN_STATUS,
  type IntentState,
  type OnchainPlan,
  type TxIntent,
} from "./policy";
import { isRoguePeriodKey } from "./scheduler";
import type { UaLegExec } from "./ua-exec";

// --- Rogue-instruction constants (doc 08 internal surface; DEMO_MODE only) --
export const ROGUE_USD = 500;
export const ROGUE_ASSET_ID = "memecoin";

// --- Tunables (PROPOSED; recorded in HANDOFF) --------------------------------
export const MAX_RETRIES = RETRY_BACKOFF_SECS.length; // 3 retries after attempt 1
const POLL_CEILING_MS = 30 * 60 * 1000; // then: unresolved, human reconciles
const POLL_CHUNK_MS = 120_000;
const PROBE_TRIES = 3;
const PROBE_GAP_MS = 7_000;
const RECONCILE_TRIES = 20;
const RECONCILE_GAP_MS = 3_000;

// --- Ports (structural, so tests inject fakes — repo convention) ------------

export interface PolicyPort {
  readPlan(planId: number | bigint): Promise<OnchainPlan>;
  staticRecord(
    planId: number | bigint,
    usd: number,
    assetIdHashHex: string,
  ): Promise<{ ok: true } | { ok: false; reason: BlockReason }>;
  prepareRecord(
    planId: number | bigint,
    usd: number,
    assetIdHashHex: string,
  ): Promise<TxIntent>;
  prepareRefund(planId: number | bigint, usd: number): Promise<TxIntent>;
  submitIntent(intent: TxIntent): Promise<IntentState>;
  reconcileIntent(intent: TxIntent): Promise<IntentState>;
}

interface PgClientLike {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}

export interface ExecutorDeps {
  db: Db;
  boss: BossLike;
  policy: PolicyPort;
  uaForLeg(plan: { id: string; userId: string }, leg: BasketLeg): UaLegExec;
  lockPool: PgPoolLike;
  demoMode: boolean;
  now?(): Date;
  sleep?(ms: number): Promise<void>;
}

// --- Per-leg advisory lock ---------------------------------------------------
// Session-scoped: a crashed process's connection death releases it. The
// loser returns silently — its pg-boss job completes untouched; the winner
// (or the janitor) owns the leg.

export interface LegLease {
  release(): Promise<void>;
}

export async function acquireLegLock(
  pool: PgPoolLike,
  periodKey: string,
): Promise<LegLease | null> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
      [periodKey],
    );
    if (res.rows[0]?.ok !== true) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    throw err;
  }
  return {
    async release() {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [periodKey],
        );
      } finally {
        client.release();
      }
    },
  };
}

// --- quote_json wrapper (the forensic trail; schema is frozen) --------------

interface ExecQuoteJson {
  attempt: number;
  rogue?: { usd: number; assetId: string };
  quote?: unknown; // raw create-time ITransaction (carries transactionId)
  policy?: { record?: TxIntent; refund?: TxIntent };
  uaDetail?: unknown; // last getTransaction payload
  pollDeadlineAt?: string;
  cause?: string; // why a refund was started (resume needs it)
  note?: string;
  decision?: string;
}

/** JSONB-safe deep copy (bigints → strings; payloads are API JSON anyway). */
const safeJson = (v: unknown): unknown =>
  v === undefined
    ? null
    : JSON.parse(
        JSON.stringify(v, (_k, val: unknown) =>
          typeof val === "bigint" ? val.toString() : val,
        ),
      );

// --- Context loading ---------------------------------------------------------

interface LegCtx {
  jobId: string;
  periodKey: string;
  jobStatus: "pending" | "running" | "done" | "failed" | "skipped";
  attempt: number;
  planId: string;
  planStatus: "draft" | "active" | "paused" | "revoked";
  paramsJson: unknown;
  contractPlanId: number | null;
  userId: string;
  region: string;
}

async function loadCtx(db: Db, jobId: string): Promise<LegCtx | null> {
  const [row] = await db
    .select({
      jobId: jobs.id,
      periodKey: jobs.periodKey,
      jobStatus: jobs.status,
      attempt: jobs.attempt,
      planId: plans.id,
      planStatus: plans.status,
      paramsJson: plans.paramsJson,
      contractPlanId: plans.contractPlanId,
      userId: plans.userId,
      region: users.region,
    })
    .from(jobs)
    .innerJoin(plans, eq(jobs.planId, plans.id))
    .innerJoin(users, eq(plans.userId, users.id))
    .where(eq(jobs.id, jobId))
    .limit(1);
  return (row as LegCtx | undefined) ?? null;
}

interface ExecRow {
  id: string;
  status:
    | "quoted"
    | "recorded"
    | "submitted"
    | "finished"
    | "refunded"
    | "blocked"
    | "failed";
  uaTxId: string | null;
  quoteJson: unknown;
  receiptText: string;
}

async function latestExecution(db: Db, jobId: string): Promise<ExecRow | null> {
  const [row] = await db
    .select({
      id: executions.id,
      status: executions.status,
      uaTxId: executions.uaTxId,
      quoteJson: executions.quoteJson,
      receiptText: executions.receiptText,
    })
    .from(executions)
    .where(eq(executions.jobId, jobId))
    .orderBy(desc(executions.createdAt))
    .limit(1);
  return (row as ExecRow | undefined) ?? null;
}

const seqFromPeriodKey = (periodKey: string): number =>
  Number(periodKey.slice(periodKey.lastIndexOf(":") + 1));

const JOB_TERMINAL = new Set(["done", "failed", "skipped"]);

// --- funding sources (UA payload shapes are unfrozen — tolerant extraction) --

export function extractFundingSources(detail: unknown, quote: unknown): string[] {
  for (const payload of [detail, quote]) {
    const deposits = (payload as { depositTokens?: unknown[] } | undefined)
      ?.depositTokens;
    if (Array.isArray(deposits) && deposits.length > 0) {
      const names = uniqueChains(deposits);
      if (names.length > 0) return names;
    }
  }
  // Fallback: the quote's per-chain userOps (funding legs).
  const ops = (quote as { userOps?: unknown[] } | undefined)?.userOps;
  if (Array.isArray(ops)) return uniqueChains(ops);
  return [];
}

function uniqueChains(items: unknown[]): string[] {
  const names: string[] = [];
  for (const item of items) {
    const rec = item as { chainId?: unknown; token?: { chainId?: unknown } };
    const chainId =
      typeof rec.chainId === "number" ? rec.chainId : rec.token?.chainId;
    if (typeof chainId !== "number") continue;
    const name = networkName(chainId);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

// =============================================================================
// The attempt runner — one instance per executeJob invocation
// =============================================================================

class LegRun {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private qj: ExecQuoteJson = { attempt: 1 };
  private execId: string | null = null;

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly ctx: LegCtx,
    private readonly params: BrokerPlanParams,
    private readonly leg: BasketLeg,
    private readonly ua: UaLegExec,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get db(): Db {
    return this.deps.db;
  }
  private get ticker(): string {
    return (
      REGISTRY.find((a) => a.id === this.leg.assetId)?.ticker ?? this.leg.assetId
    );
  }
  private get planIdOnchain(): number {
    return this.ctx.contractPlanId as number;
  }

  // --- persistence helpers ---------------------------------------------------

  private adopt(row: ExecRow): void {
    this.execId = row.id;
    this.qj = ((row.quoteJson as ExecQuoteJson | null) ?? {
      attempt: 1,
    }) as ExecQuoteJson;
  }

  private async saveQj(patch: Partial<ExecQuoteJson>): Promise<void> {
    this.qj = { ...this.qj, ...patch };
    await this.db
      .update(executions)
      .set({ quoteJson: this.qj as unknown as Record<string, unknown> })
      .where(eq(executions.id, this.execId as string));
  }

  private async setExec(fields: {
    status?: ExecRow["status"];
    receiptText?: string;
    uaTxId?: string;
    feesJson?: FeeTotalsUSD;
  }): Promise<void> {
    await this.db
      .update(executions)
      .set(fields as Record<string, unknown>)
      .where(eq(executions.id, this.execId as string));
  }

  private async markJob(status: "done" | "failed" | "skipped"): Promise<void> {
    await this.db.update(jobs).set({ status }).where(eq(jobs.id, this.ctx.jobId));
  }

  // --- entry: dispatch on persisted state -------------------------------------

  async run(last: ExecRow | null): Promise<void> {
    if (!last) return this.startAttempt(1);
    this.adopt(last);

    switch (last.status) {
      case "quoted":
        return this.resumeQuoted();
      case "recorded":
        return this.resumeRecorded();
      case "submitted":
        return this.pollPhase(last.uaTxId as string);
      case "refunded":
      case "failed": {
        if (last.receiptText === "") {
          // Mid-ladder marker: the scheduled retry send may have been lost
          // (crash) — pg-boss crash-retry or the janitor lands here.
          const attempt = this.qj.attempt ?? this.ctx.attempt ?? 1;
          if (attempt <= MAX_RETRIES) return this.startAttempt(attempt + 1);
          return this.exhaust(last.status === "refunded");
        }
        return this.markJob(last.status === "refunded" ? "skipped" : "failed");
      }
      case "blocked":
      case "finished":
        return this.markJob("done"); // crash landed between row and job update
      default:
        return;
    }
  }

  // --- fresh attempt -----------------------------------------------------------

  private async startAttempt(attempt: number): Promise<void> {
    breadcrumb("step0:attempt", { jobId: this.ctx.jobId, attempt });
    await this.db.update(jobs).set({ attempt }).where(eq(jobs.id, this.ctx.jobId));
    this.ctx.attempt = attempt;

    // Step 1 — plan state (DB + contract view). Nothing recorded yet, so an
    // inactive plan is a pre-record halt: blocked receipt, no refund.
    if (this.ctx.planStatus !== "active") {
      return this.terminalBlocked("NotActive", null, "skipped", { insert: true });
    }
    const onchain = await this.deps.policy.readPlan(this.planIdOnchain);
    breadcrumb("step1:read-plan", {
      status: onchain.status,
      spentInPeriod: onchain.spentInPeriod.toString(),
    });
    if (onchain.status !== PLAN_STATUS.Active) {
      return this.terminalBlocked("NotActive", onchain, "skipped", { insert: true });
    }

    const [row] = await this.db
      .insert(executions)
      .values({
        jobId: this.ctx.jobId,
        status: "quoted",
        receiptText: "",
        quoteJson: { attempt } as Record<string, unknown>,
      })
      .returning({ id: executions.id });
    this.execId = row.id;
    this.qj = { attempt };

    return this.runFromQuoted(onchain);
  }

  /** Steps 2–3b on a fresh quote, then into the shared 3c–6 path. */
  private async runFromQuoted(onchain: OnchainPlan): Promise<void> {
    const asset = REGISTRY.find((a) => a.id === this.leg.assetId);

    // Step 3a — pinned registry + region re-check (G11; doc 04 semantics).
    if (
      !asset ||
      !eligibleAssets(this.ctx.region).some((a) => a.id === this.leg.assetId)
    ) {
      return this.terminalBlocked("AssetNotAllowed", onchain, "skipped");
    }

    // Step 3b — cap courtesy checks, usd6 bigints only (CONFLICTS #11).
    const legUsd6 = toUsd6(this.leg.usd);
    const nowSec = Math.floor(this.now().getTime() / 1000);
    if (legUsd6 > onchain.capPerExec) {
      return this.terminalBlocked("OverExecCap", onchain, "done");
    }
    if (effectiveSpent(onchain, nowSec) + legUsd6 > onchain.capPerPeriod) {
      return this.terminalBlocked("OverPeriodCap", onchain, "done");
    }

    // Step 2 — quote; the create-time transactionId hits disk before signing.
    const tx = await this.ua.quote(
      { chainId: asset.chainId, address: asset.address },
      this.leg.usd,
      async (t) => this.saveQj({ quote: safeJson(t) }),
    );
    breadcrumb("step2:quote", { legUsd: this.leg.usd, asset: this.leg.assetId });

    return this.preflightRecordAndSend(onchain, tx, { skipRecord: false });
  }

  /**
   * Steps 3c (fees/BP) → 4 (record; skipped on a recorded resume) → 5
   * (re-read + send) → 6 (poll). `tx` is always a quote created in THIS
   * process moments ago — stale persisted quotes are never sent.
   */
  private async preflightRecordAndSend(
    onchain: OnchainPlan,
    tx: ITransaction,
    opts: { skipRecord: boolean },
  ): Promise<void> {
    const fees = parseFeeTotals(tx);

    // Step 3c — quote integrity + slippage sanity (PROPOSED bound: fees ≤
    // max($0.50, 5% of leg); tradeConfig slippage stays pinned at 100 bps
    // in @retenix/ua and is never widened) + buying power (PS-F4.4).
    const rootHash = (tx as { rootHash?: unknown }).rootHash;
    const feeCeiling = Math.max(0.5, this.leg.usd * 0.05);
    if (typeof rootHash !== "string" || rootHash.length === 0 || fees.total > feeCeiling) {
      breadcrumb("step3:quote-sanity-failed", { fees: fees.total, feeCeiling });
      return this.failAttempt("quote-sanity", { refund: opts.skipRecord });
    }
    const buyingPower = await this.ua.buyingPowerUsd();
    const needed = this.leg.usd + fees.total;
    if (buyingPower < needed) {
      return this.skipInsufficient(buyingPower, needed, { recorded: opts.skipRecord });
    }
    breadcrumb("step3:preflight-ok", { buyingPower, needed });

    if (!opts.skipRecord) {
      // Step 4 — the contract gate. staticCall first: expected reverts
      // become receipts in seconds and never broadcast.
      const gate = await this.deps.policy.staticRecord(
        this.planIdOnchain,
        this.leg.usd,
        assetIdHash(this.leg.assetId),
      );
      if (!gate.ok) {
        return this.terminalBlocked(gate.reason, onchain, "done");
      }
      const settled = await this.settleIntent(
        "record",
        () =>
          this.deps.policy.prepareRecord(
            this.planIdOnchain,
            this.leg.usd,
            assetIdHash(this.leg.assetId),
          ),
        this.qj.policy?.record,
        "submit",
      );
      if (settled.state === "reverted") {
        return this.terminalBlocked(settled.reason, onchain, "done");
      }
      await this.setExec({ status: "recorded" });
      breadcrumb("step4:recorded", { txHash: this.qj.policy?.record?.txHash });
    }

    // Step 5 — revoke-mid-flight re-read (doc 07 family 3): NEVER send
    // after a revoke, even though recordExecution already landed.
    const halt = await this.planHalted();
    if (halt) return this.refundThenHalt(halt);

    let transactionId: string;
    try {
      ({ transactionId } = await this.ua.sendQuoted(tx));
    } catch (err) {
      breadcrumb("step5:send-failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      return this.failAttempt("send-error", { refund: true });
    }
    await this.setExec({ status: "submitted", uaTxId: transactionId });
    await this.saveQj({
      pollDeadlineAt: new Date(this.now().getTime() + POLL_CEILING_MS).toISOString(),
    });
    breadcrumb("step5:submitted", { transactionId });

    return this.pollPhase(transactionId);
  }

  // --- resume branches ---------------------------------------------------------

  private async resumeQuoted(): Promise<void> {
    const record = this.qj.policy?.record;
    const onchain = await this.deps.policy.readPlan(this.planIdOnchain);
    if (!record) {
      // Crash before the record intent: the persisted quote was never
      // signed, so it can never execute — refresh it on the same row.
      if (onchain.status !== PLAN_STATUS.Active || this.ctx.planStatus !== "active") {
        return this.terminalBlocked("NotActive", onchain, "skipped");
      }
      return this.runFromQuoted(onchain);
    }
    // Record intent persisted — classify it; never re-fire blindly.
    const settled = await this.settleIntent(
      "record",
      () =>
        this.deps.policy.prepareRecord(
          this.planIdOnchain,
          this.leg.usd,
          assetIdHash(this.leg.assetId),
        ),
      record,
      "reconcile",
    );
    if (settled.state === "reverted") {
      return this.terminalBlocked(settled.reason, onchain, "done");
    }
    await this.setExec({ status: "recorded" });
    return this.resumeRecorded();
  }

  private async resumeRecorded(): Promise<void> {
    // S9 — a persisted refund intent means we crashed mid-refund: finish
    // THAT first (a double refundExecution would deflate spentInPeriod and
    // under-enforce the user's cap).
    if (this.qj.policy?.refund) {
      await this.completeRefund();
      return this.afterRefund(this.qj.cause ?? "send-error");
    }

    const halt = await this.planHalted();
    if (halt) return this.refundThenHalt(halt);

    // Send-evidence probe: was the persisted quote's transactionId ever
    // registered? Ambiguity resolves toward "sent" — the wrong-direction
    // cost is an unresolved receipt, never a duplicate buy.
    const persistedId = (this.qj.quote as { transactionId?: unknown } | undefined)
      ?.transactionId;
    if (typeof persistedId === "string" && persistedId.length > 0) {
      for (let i = 0; i < PROBE_TRIES; i += 1) {
        const probe = await this.ua.probeTransaction(persistedId);
        if (probe.found) {
          await this.setExec({ status: "submitted", uaTxId: persistedId });
          if (!this.qj.pollDeadlineAt) {
            await this.saveQj({
              pollDeadlineAt: new Date(
                this.now().getTime() + POLL_CEILING_MS,
              ).toISOString(),
            });
          }
          breadcrumb("resume:probe-found", { transactionId: persistedId });
          return this.pollPhase(persistedId);
        }
        if (i < PROBE_TRIES - 1) await this.sleep(PROBE_GAP_MS);
      }
      breadcrumb("resume:probe-not-found", { transactionId: persistedId });
    }

    // Definitively never sent → fresh quote (stale ones are never reused),
    // preflight again, SKIP step 4 (already recorded), send.
    const onchain = await this.deps.policy.readPlan(this.planIdOnchain);
    const asset = REGISTRY.find((a) => a.id === this.leg.assetId);
    if (!asset) {
      // Registry drift mid-flight — refund the budget and fail loudly.
      await this.startRefund("registry-drift");
      return this.afterRefund("registry-drift");
    }
    const tx = await this.ua.quote(
      { chainId: asset.chainId, address: asset.address },
      this.leg.usd,
      async (t) => this.saveQj({ quote: safeJson(t) }),
    );
    return this.preflightRecordAndSend(onchain, tx, { skipRecord: true });
  }

  // --- step 6: poll ------------------------------------------------------------

  private async pollPhase(transactionId: string): Promise<void> {
    const deadlineIso =
      this.qj.pollDeadlineAt ??
      new Date(this.now().getTime() + POLL_CEILING_MS).toISOString();
    if (!this.qj.pollDeadlineAt) await this.saveQj({ pollDeadlineAt: deadlineIso });
    const deadline = new Date(deadlineIso).getTime();

    for (;;) {
      const left = deadline - this.now().getTime();
      if (left <= 0) break;
      const result = await this.ua.pollTx(transactionId, {
        timeoutMs: Math.min(POLL_CHUNK_MS, left),
      });
      if (result.outcome === "finished") {
        return this.finish(transactionId, result.t);
      }
      if (result.outcome === "refunded") {
        // UA REFUND 8–11: the user's money came back; credit the period
        // budget and walk the ladder.
        await this.saveQj({ uaDetail: safeJson(result.t) });
        breadcrumb("step6:ua-refunded", { transactionId, status: result.t.status });
        return this.failAttempt("ua-refund", { refund: true });
      }
      breadcrumb("step6:poll-timeout-chunk", { transactionId });
    }

    // Poll ceiling exceeded: the tx may STILL complete. Auto-refunding here
    // would deflate spentInPeriod if it later finishes (cap under-
    // enforcement), and auto-retrying could double-buy — a human decides.
    await this.setExec({
      status: "failed",
      receiptText: unresolvedReceipt(this.leg.usd, this.ticker),
    });
    await this.markJob("failed");
    await recordEvent(this.db, "execution.unresolved", this.ctx.userId, {
      planId: this.ctx.planId,
      jobId: this.ctx.jobId,
      transactionId,
      legUsd: this.leg.usd,
    });
    await slack(
      `:hourglass_flowing_sand: UNRESOLVED buy — ${this.ticker} $${this.leg.usd}, UA tx not terminal after ${POLL_CEILING_MS / 60_000} min. No refund issued (a late completion would deflate the period cap). Needs a human: ${activityUrl(transactionId)}`,
    );
  }

  // --- terminal outcomes + ladder -----------------------------------------------

  private async finish(
    transactionId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const feeSource = (this.qj.quote ?? detail) as { feeQuotes?: unknown[] };
    const fees = parseFeeTotals(feeSource);
    const sources = extractFundingSources(detail, this.qj.quote);
    const receipt = executedReceipt({
      usd: this.leg.usd,
      ticker: this.ticker,
      sources,
      fees,
    });
    await this.saveQj({ uaDetail: safeJson(detail) });
    await this.setExec({ status: "finished", receiptText: receipt, feesJson: fees });
    await this.markJob("done");
    breadcrumb("step6:finished", { transactionId });
    await slack(`:white_check_mark: ${receipt} — ${activityUrl(transactionId)}`);
  }

  private sentence(reason: BlockReason, onchain: OnchainPlan | null): string {
    if (reason === "OverExecCap" && onchain) {
      return blockedReceipt(
        reason,
        capText(onchain.capPerExec, onchain.periodSecs, "exec"),
      );
    }
    if (reason === "OverPeriodCap" && onchain) {
      return blockedReceipt(
        reason,
        capText(onchain.capPerPeriod, onchain.periodSecs, "period"),
      );
    }
    return blockedReceipt(reason, "");
  }

  private async terminalBlocked(
    reason: BlockReason,
    onchain: OnchainPlan | null,
    jobState: "done" | "skipped",
    opts: { insert?: boolean } = {},
  ): Promise<void> {
    const receiptText = this.sentence(reason, onchain);
    if (opts.insert || !this.execId) {
      const [row] = await this.db
        .insert(executions)
        .values({
          jobId: this.ctx.jobId,
          status: "blocked",
          receiptText,
          quoteJson: {
            attempt: this.ctx.attempt || 1,
            decision: reason,
          } as Record<string, unknown>,
        })
        .returning({ id: executions.id });
      this.execId = row.id;
    } else {
      await this.saveQj({ decision: reason });
      await this.setExec({ status: "blocked", receiptText });
    }
    await this.markJob(jobState);
    await recordEvent(this.db, "execution.blocked", this.ctx.userId, {
      planId: this.ctx.planId,
      jobId: this.ctx.jobId,
      reason,
      legUsd: this.leg.usd,
      asset: this.leg.assetId,
    });
    await slack(
      `:no_entry: ${receiptText} — plan ${this.ctx.planId}, ${this.ticker} $${this.leg.usd}`,
    );
    breadcrumb("terminal:blocked", { reason });
  }

  /** Revoked/paused after recordExecution: refund the budget, never send. */
  private async refundThenHalt(cause: "revoked" | "paused"): Promise<void> {
    await this.startRefund(cause);
    await this.setExec({
      status: "refunded",
      receiptText: revokedReceipt(this.leg.usd, this.ticker, cause),
    });
    await this.markJob("skipped");
    await recordEvent(this.db, "execution.skipped", this.ctx.userId, {
      planId: this.ctx.planId,
      jobId: this.ctx.jobId,
      cause,
      legUsd: this.leg.usd,
      topUpOptIn: this.params.topUpOptIn ?? false,
    });
    await slack(
      `:octagonal_sign: plan ${this.ctx.planId} ${cause} mid-flight — ${this.ticker} $${this.leg.usd} leg halted before the send; period budget refunded`,
    );
  }

  private async skipInsufficient(
    buyingPower: number,
    needed: number,
    opts: { recorded: boolean },
  ): Promise<void> {
    if (opts.recorded) await this.startRefund("insufficient-buying-power");
    const shortUsd = Math.max(0.01, Math.round((needed - buyingPower) * 100) / 100);
    const receiptText = skippedReceipt({
      usd: this.leg.usd,
      ticker: this.ticker,
      shortUsd,
      cadence: this.params.cadence,
    });
    await this.setExec({
      status: opts.recorded ? "refunded" : "failed",
      receiptText,
    });
    await this.markJob("skipped");
    await recordEvent(this.db, "execution.skipped", this.ctx.userId, {
      planId: this.ctx.planId,
      jobId: this.ctx.jobId,
      cause: "insufficient-buying-power",
      legUsd: this.leg.usd,
      shortUsd,
      topUpOptIn: this.params.topUpOptIn ?? false,
    });
    await slack(`:zzz: ${receiptText} (plan ${this.ctx.planId})`);
    breadcrumb("terminal:skipped-bp", { buyingPower, needed });
  }

  /**
   * Step 7 — the honest failure ladder. Refund FIRST (when something was
   * recorded), THEN schedule the retry (30s/2m/10m, suffixed singleton
   * keys), THEN exhaust into skip-and-notify. Nothing silent.
   */
  private async failAttempt(cause: string, opts: { refund: boolean }): Promise<void> {
    if (opts.refund) await this.startRefund(cause);
    else await this.saveQj({ cause });
    return this.afterRefund(cause);
  }

  private async afterRefund(cause: string): Promise<void> {
    const refunded = Boolean(this.qj.policy?.refund);
    const attempt = this.qj.attempt ?? this.ctx.attempt ?? 1;
    if (attempt <= MAX_RETRIES) {
      const delay = RETRY_BACKOFF_SECS[attempt - 1];
      // Persist the mid-ladder marker BEFORE the send: a lost send is
      // rescued by the janitor; a duplicate is defused by the advisory lock.
      await this.setExec({
        status: refunded ? "refunded" : "failed",
        receiptText: "", // mid-ladder; module 11 renders non-empty only
      });
      await this.deps.boss.send(
        EXECUTE_QUEUE,
        { jobId: this.ctx.jobId },
        { singletonKey: `${this.ctx.periodKey}#a${attempt}`, startAfter: delay },
      );
      breadcrumb("step7:retry-scheduled", { cause, nextAttempt: attempt + 1, delay });
      await slack(
        `:arrows_counterclockwise: ${this.ticker} $${this.leg.usd} leg failed (${cause}) — attempt ${attempt}/${MAX_RETRIES + 1}; retrying in ${delay}s${refunded ? " (period budget refunded)" : ""}`,
      );
      return;
    }
    return this.exhaust(refunded);
  }

  private async exhaust(refunded: boolean): Promise<void> {
    // The DoD's "failed-refunded receipt": money either came back (UA
    // refund) or never left (send-level failure) — both truthfully read
    // "was returned".
    await this.setExec({
      status: refunded ? "refunded" : "failed",
      receiptText: refundedReceipt(this.leg.usd),
    });
    await this.markJob("skipped");
    await recordEvent(this.db, "execution.failed", this.ctx.userId, {
      planId: this.ctx.planId,
      jobId: this.ctx.jobId,
      cause: this.qj.cause ?? "exhausted",
      attempts: this.qj.attempt ?? this.ctx.attempt,
      legUsd: this.leg.usd,
    });
    await slack(
      `:x: ${this.ticker} $${this.leg.usd} leg exhausted its retries (${this.qj.cause ?? "unknown"}) — receipt written, job skipped. Plan ${this.ctx.planId}.`,
    );
    breadcrumb("step7:exhausted", {});
  }

  // --- refund machinery (write-ahead, double-refund-proof) ---------------------

  private async startRefund(cause: string): Promise<void> {
    await this.saveQj({ cause });
    if (this.qj.policy?.refund) return this.completeRefund();
    const settled = await this.settleIntent(
      "refund",
      () => this.deps.policy.prepareRefund(this.planIdOnchain, this.leg.usd),
      undefined,
      "submit",
    );
    if (settled.state === "reverted") {
      // refundExecution only reverts on NotAgent/nonexistent — loud alert;
      // the period budget stays conservatively SPENT (the safe direction).
      captureError(new Error(`refundExecution reverted (${settled.reason})`), {
        jobId: this.ctx.jobId,
      });
      await slack(
        `:rotating_light: refundExecution REVERTED (${settled.reason}) for plan ${this.ctx.planId} — period budget left spent; check agent wiring`,
      );
    }
    breadcrumb("step7:refunded", { cause });
  }

  private async completeRefund(): Promise<void> {
    const settled = await this.settleIntent(
      "refund",
      () => this.deps.policy.prepareRefund(this.planIdOnchain, this.leg.usd),
      this.qj.policy?.refund,
      "reconcile",
    );
    if (settled.state === "reverted") {
      captureError(new Error("persisted refund intent reverted"), {
        jobId: this.ctx.jobId,
      });
    }
  }

  /**
   * Drive a write-ahead intent to a decision. `existing` (resume) starts
   * with reconcile — never a blind re-fire; a `dead` verdict (nonce
   * consumed by another tx, hash absent) is the only path that re-prepares.
   */
  private async settleIntent(
    kind: "record" | "refund",
    prepare: () => Promise<TxIntent>,
    existing: TxIntent | undefined,
    mode: "submit" | "reconcile",
  ): Promise<{ state: "included" } | { state: "reverted"; reason: BlockReason }> {
    let intent = existing;
    if (!intent) {
      intent = await prepare();
      await this.persistIntent(kind, intent);
    }
    let state: IntentState =
      mode === "submit"
        ? await this.deps.policy.submitIntent(intent)
        : await this.deps.policy.reconcileIntent(intent);

    for (let i = 0; i < RECONCILE_TRIES; i += 1) {
      if (state.state === "included") return { state: "included" };
      if (state.state === "reverted") return { state: "reverted", reason: state.reason };
      if (state.state === "dead") {
        intent = await prepare();
        await this.persistIntent(kind, intent);
        state = await this.deps.policy.submitIntent(intent);
        continue;
      }
      await this.sleep(RECONCILE_GAP_MS);
      state = await this.deps.policy.reconcileIntent(intent);
    }
    throw new Error(`${kind} intent still pending after ${RECONCILE_TRIES} reconciles`);
  }

  private async persistIntent(kind: "record" | "refund", intent: TxIntent): Promise<void> {
    await this.saveQj({ policy: { ...this.qj.policy, [kind]: intent } });
  }

  // --- shared checks -------------------------------------------------------------

  /** Re-read BOTH truths (DB row + contract) right before a send. */
  private async planHalted(): Promise<"revoked" | "paused" | null> {
    const [row] = await this.db
      .select({ status: plans.status })
      .from(plans)
      .where(eq(plans.id, this.ctx.planId));
    if (row && row.status !== "active") {
      return row.status === "paused" ? "paused" : "revoked";
    }
    const onchain = await this.deps.policy.readPlan(this.planIdOnchain);
    if (onchain.status === PLAN_STATUS.Paused) return "paused";
    if (onchain.status === PLAN_STATUS.Revoked) return "revoked";
    return null;
  }
}

// =============================================================================
// Entry point (pg-boss handler body)
// =============================================================================

export async function executeJob(
  deps: ExecutorDeps,
  payload: { jobId: string },
): Promise<void> {
  const ctx = await loadCtx(deps.db, payload.jobId);
  if (!ctx) return; // job deleted — nothing to do
  if (JOB_TERMINAL.has(ctx.jobStatus)) return;

  const lease = await acquireLegLock(deps.lockPool, ctx.periodKey);
  if (!lease) {
    breadcrumb("lock-busy", { jobId: ctx.jobId, periodKey: ctx.periodKey });
    return; // a twin runner owns this leg
  }

  try {
    if (ctx.jobStatus === "pending") {
      await deps.db.update(jobs).set({ status: "running" }).where(eq(jobs.id, ctx.jobId));
    }

    if (isRoguePeriodKey(ctx.periodKey)) {
      return await runRogue(deps, ctx);
    }

    const parsed = brokerParamsSchema.safeParse(ctx.paramsJson);
    if (!parsed.success || ctx.contractPlanId == null) {
      await deps.db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, ctx.jobId));
      await recordEvent(deps.db, "plan.params_invalid", ctx.userId, {
        planId: ctx.planId,
        jobId: ctx.jobId,
      });
      await slack(`:x: job ${ctx.jobId}: plan params failed validation at execute time`);
      return;
    }
    const legs = computeLegs(parsed.data);
    const seq = seqFromPeriodKey(ctx.periodKey);
    const leg = legs.find((l) => l.seq === seq);
    if (!leg) {
      await deps.db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, ctx.jobId));
      await recordEvent(deps.db, "execution.failed", ctx.userId, {
        planId: ctx.planId,
        jobId: ctx.jobId,
        cause: "leg-mismatch",
      });
      await slack(
        `:x: job ${ctx.jobId}: leg seq ${seq} no longer exists for plan ${ctx.planId} (params drift?) — failed honestly`,
      );
      return;
    }

    const ua = deps.uaForLeg({ id: ctx.planId, userId: ctx.userId }, leg);
    const runner = new LegRun(deps, ctx, parsed.data, leg, ua);
    const last = await latestExecution(deps.db, ctx.jobId);
    await runner.run(last);
  } catch (err) {
    captureError(err, { jobId: ctx.jobId, periodKey: ctx.periodKey });
    throw err; // infra fault → pg-boss crash retry resumes the state machine
  } finally {
    await lease.release();
  }
}

/**
 * DEMO_MODE rogue instruction: a deliberately out-of-policy attempt that
 * must fail at STEP 4, ONCHAIN, through the real machinery (beat 5).
 * Quote/preflight are skipped — no quote exists for a fake asset; that is
 * the point: the courtesy layer is bypassed and the contract still blocks.
 */
async function runRogue(deps: ExecutorDeps, ctx: LegCtx): Promise<void> {
  if (ctx.contractPlanId == null) {
    await deps.db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, ctx.jobId));
    await slack(`:x: rogue job ${ctx.jobId}: plan has no contract_plan_id`);
    return;
  }
  const onchain = await deps.policy.readPlan(ctx.contractPlanId);
  const gate = await deps.policy.staticRecord(
    ctx.contractPlanId,
    ROGUE_USD,
    assetIdHash(ROGUE_ASSET_ID),
  );

  if (gate.ok) {
    // The demo premise failed — recording spend for an unbuyable fake asset
    // has no compensating path. Do NOT broadcast; alert loudly.
    await deps.db.insert(executions).values({
      jobId: ctx.jobId,
      status: "failed",
      receiptText: "",
      quoteJson: {
        attempt: 1,
        rogue: { usd: ROGUE_USD, assetId: ROGUE_ASSET_ID },
        note: "staticRecord unexpectedly PASSED — nothing broadcast",
      } as Record<string, unknown>,
    });
    await deps.db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, ctx.jobId));
    await slack(
      `:rotating_light: rogue demo did NOT revert (plan ${ctx.planId}) — check the plan's caps/allowlist; nothing was broadcast`,
    );
    return;
  }

  const reason = gate.reason;
  const receiptText =
    reason === "OverExecCap"
      ? blockedReceipt(reason, capText(onchain.capPerExec, onchain.periodSecs, "exec"))
      : reason === "OverPeriodCap"
        ? blockedReceipt(reason, capText(onchain.capPerPeriod, onchain.periodSecs, "period"))
        : blockedReceipt(reason, "");
  await deps.db.insert(executions).values({
    jobId: ctx.jobId,
    status: "blocked",
    receiptText,
    quoteJson: {
      attempt: 1,
      rogue: { usd: ROGUE_USD, assetId: ROGUE_ASSET_ID },
      decision: reason,
    } as Record<string, unknown>,
  });
  await deps.db.update(jobs).set({ status: "done" }).where(eq(jobs.id, ctx.jobId));
  await recordEvent(deps.db, "execution.blocked", ctx.userId, {
    planId: ctx.planId,
    jobId: ctx.jobId,
    reason,
    rogue: true,
    legUsd: ROGUE_USD,
  });
  await slack(
    `:shield: Rogue instruction blocked ONCHAIN (${reason}) — "${receiptText}" (plan ${ctx.planId})`,
  );
  breadcrumb("rogue:blocked", { reason });
}
