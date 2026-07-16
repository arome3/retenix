import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  events,
  executions,
  getDb,
  getPool,
  jobs,
  plans,
  users,
  type Db,
} from "@retenix/db";
import type { BlockReason } from "@retenix/shared";
import type { PollResult } from "@retenix/ua";

import type { BossLike } from "./ctx";
import {
  MAX_RETRIES,
  ROGUE_USD,
  executeJob,
  extractFundingSources,
  type ExecutorDeps,
  type PolicyPort,
} from "./executor";
import type { IntentState, OnchainPlan, TxIntent } from "./policy";
import type { UaLegExec } from "./ua-exec";

const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL must be set in CI — db tests may not be skipped");
}
if (!url) {
  console.warn("[worker] DATABASE_URL not set — skipping executor db tests");
}

// --- fixtures -----------------------------------------------------------------

const ANCHOR = new Date("2026-07-13T09:00:00.000Z");
const ANCHOR_SEC = Math.floor(ANCHOR.getTime() / 1000);

/** Canonical-sample fee quote: gas $0.03 / service $0.08 / LP $0.03. */
const quoteFixture = (transactionId: string) => ({
  transactionId,
  rootHash: `0x${"ab".repeat(32)}`,
  feeQuotes: [
    {
      fees: {
        totals: {
          gasFeeTokenAmountInUSD: "30000000000000000",
          transactionServiceFeeTokenAmountInUSD: "80000000000000000",
          transactionLPFeeTokenAmountInUSD: "30000000000000000",
        },
      },
    },
  ],
  depositTokens: [{ token: { chainId: 8453 } }, { token: { chainId: 42161 } }],
  userOps: [{ chainId: 8453 }, { chainId: 42161 }],
});

const finishedDetail = () => ({
  status: 7,
  depositTokens: [{ token: { chainId: 8453 } }, { token: { chainId: 42161 } }],
  tokenChanges: {
    incr: [
      {
        token: { address: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W" },
        amount: "0.02411",
      },
    ],
  },
});

const CANONICAL_RECEIPT =
  "Bought $15.00 of SPYx · funded from Base + Arbitrum · fees $0.14 (gas $0.03, service $0.08, LP $0.03) · view onchain";

// --- fakes ----------------------------------------------------------------------

class FakePolicy implements PolicyPort {
  planStatuses: number[] = [0];
  capPerExec = 50_000_000n;
  capPerPeriod = 50_000_000n;
  spentInPeriod = 0n;
  staticResult: { ok: true } | { ok: false; reason: BlockReason } = { ok: true };
  submitResult: (i: TxIntent) => IntentState = () =>
    ({ state: "included", receipt: {} as never }) as IntentState;
  reconcileResult: (i: TxIntent) => IntentState = () =>
    ({ state: "included", receipt: {} as never }) as IntentState;
  private nonce = 0;

  constructor(private readonly log: string[]) {}

  readPlan(): Promise<OnchainPlan> {
    this.log.push("policy.readPlan");
    const status =
      this.planStatuses.length > 1
        ? (this.planStatuses.shift() as number)
        : this.planStatuses[0];
    return Promise.resolve({
      owner: "0xowner",
      agent: "0xagent",
      capPerExec: this.capPerExec,
      capPerPeriod: this.capPerPeriod,
      periodSecs: 604_800,
      spentInPeriod: this.spentInPeriod,
      periodStart: ANCHOR_SEC,
      assetListHash: "0x",
      status,
    });
  }
  staticRecord(): Promise<{ ok: true } | { ok: false; reason: BlockReason }> {
    this.log.push("policy.staticRecord");
    return Promise.resolve(this.staticResult);
  }
  prepareRecord(): Promise<TxIntent> {
    this.log.push("policy.prepareRecord");
    return Promise.resolve(this.intent("record"));
  }
  prepareRefund(): Promise<TxIntent> {
    this.log.push("policy.prepareRefund");
    return Promise.resolve(this.intent("refund"));
  }
  submitIntent(i: TxIntent): Promise<IntentState> {
    this.log.push(`policy.submitIntent:${i.kind}`);
    return Promise.resolve(this.submitResult(i));
  }
  reconcileIntent(i: TxIntent): Promise<IntentState> {
    this.log.push(`policy.reconcileIntent:${i.kind}`);
    return Promise.resolve(this.reconcileResult(i));
  }
  private intent(kind: TxIntent["kind"]): TxIntent {
    this.nonce += 1;
    return {
      kind,
      nonce: this.nonce,
      txHash: `0x${kind}${this.nonce}`,
      raw: "0xraw",
      chainId: 42161,
    };
  }
}

class FakeUa implements UaLegExec {
  ownerAddress = "0xagent";
  quoteId = "UA-1";
  sendError: Error | null = null;
  buyingPower = 10_000;
  probeScript: boolean[] = [];
  pollScript: PollResult[] = [];

  constructor(private readonly log: string[]) {}

  async quote(
    _token: { chainId: number; address: string },
    _amountUsd: number,
    persist: (tx: never) => Promise<void>,
  ): Promise<never> {
    this.log.push("ua.quote");
    const tx = quoteFixture(this.quoteId);
    await persist(tx as never);
    this.log.push("ua.quote:persisted");
    return tx as never;
  }
  sendQuoted(tx: never): Promise<{ transactionId: string }> {
    this.log.push("ua.sendQuoted");
    if (this.sendError) return Promise.reject(this.sendError);
    const id = (tx as { transactionId?: string }).transactionId ?? this.quoteId;
    return Promise.resolve({ transactionId: id });
  }
  probeTransaction(): Promise<{ found: boolean }> {
    this.log.push("ua.probe");
    return Promise.resolve({
      found: this.probeScript.length > 0 ? (this.probeScript.shift() as boolean) : false,
    });
  }
  pollTx(): Promise<PollResult> {
    this.log.push("ua.pollTx");
    const r =
      this.pollScript.length > 1
        ? (this.pollScript.shift() as PollResult)
        : (this.pollScript[0] ?? {
            outcome: "finished" as const,
            t: finishedDetail() as never,
          });
    return Promise.resolve(r);
  }
  buyingPowerUsd(): Promise<number> {
    this.log.push("ua.buyingPower");
    return Promise.resolve(this.buyingPower);
  }
}

interface SentJob {
  data: { jobId: string };
  opts: { singletonKey: string; startAfter?: number };
}

// --- db seeding ------------------------------------------------------------------

describe.skipIf(!url)("executor (db-backed state machine)", () => {
  let db: Db;
  const userId = randomUUID();
  const planIds: string[] = [];

  beforeAll(async () => {
    db = getDb();
    await db.insert(users).values({
      id: userId,
      emailHash: `exec-${userId}`,
      eoaAddr: `0xexec${userId}`,
      uaEvmAddr: "0x0000000000000000000000000000000000000000",
      uaSolAddr: "So11111111111111111111111111111111111111112",
      region: "NG",
    });
  });

  afterAll(async () => {
    if (planIds.length > 0) {
      await db
        .delete(executions)
        .where(
          inArray(
            executions.jobId,
            db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.planId, planIds)),
          ),
        );
      await db.delete(jobs).where(inArray(jobs.planId, planIds));
      await db.delete(events).where(eq(events.userId, userId));
      await db.delete(plans).where(inArray(plans.id, planIds));
    }
    await db.delete(users).where(eq(users.id, userId));
    await getPool().end();
  });

  async function seedLeg(opts: {
    planStatus?: "active" | "revoked" | "paused";
    topUpOptIn?: boolean;
    rogue?: boolean;
    jobStatus?: "pending" | "running";
    seq?: number;
  } = {}): Promise<{ planId: string; jobId: string; periodKey: string }> {
    const planId = randomUUID();
    planIds.push(planId);
    await db.insert(plans).values({
      id: planId,
      userId,
      kind: "broker",
      status: opts.planStatus ?? "active",
      contractPlanId: 42,
      activatedAt: ANCHOR,
      paramsJson: {
        cadence: "weekly",
        amountUsd: 25,
        basket: [
          { assetId: "spyx", pct: 60 },
          { assetId: "tslax", pct: 30 },
          { assetId: "sol", pct: 10 },
        ],
        capPerExecUsd: 50,
        capPerPeriodUsd: 50,
        periodSecs: 604_800,
        nextRunAt: "2026-07-23T09:00:00.000Z",
        topUpOptIn: opts.topUpOptIn ?? false,
      },
    });
    const periodKey = opts.rogue
      ? `${planId}:rogue:${randomUUID()}`
      : `${planId}:${ANCHOR.toISOString()}:${opts.seq ?? 0}`;
    const [job] = await db
      .insert(jobs)
      .values({
        planId,
        runAt: ANCHOR,
        periodKey,
        status: opts.jobStatus ?? "pending",
      })
      .returning({ id: jobs.id });
    return { planId, jobId: job.id, periodKey };
  }

  function makeDeps(log: string[]): {
    deps: ExecutorDeps;
    policy: FakePolicy;
    ua: FakeUa;
    sends: SentJob[];
  } {
    const policy = new FakePolicy(log);
    const ua = new FakeUa(log);
    const sends: SentJob[] = [];
    const boss: BossLike = {
      send: (_n, data, opts) => {
        log.push(`boss.send:${opts.singletonKey}`);
        sends.push({ data: data as { jobId: string }, opts });
        return Promise.resolve("q");
      },
    };
    const deps: ExecutorDeps = {
      db,
      boss,
      policy,
      uaForLeg: () => ua,
      lockPool: getPool(),
      demoMode: true,
      sleep: () => Promise.resolve(),
    };
    return { deps, policy, ua, sends };
  }

  const execOf = async (jobId: string) => {
    const rows = await db
      .select()
      .from(executions)
      .where(eq(executions.jobId, jobId))
      .orderBy(executions.createdAt);
    return rows;
  };
  const jobOf = async (jobId: string) => {
    const [j] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    return j;
  };
  const eventOf = async (jobId: string, type: string) =>
    db
      .select()
      .from(events)
      .where(sql`${events.type} = ${type} AND ${events.payloadJson}->>'jobId' = ${jobId}`);

  // ---------------------------------------------------------------------------

  it("happy path: quote → preflight → record (included) → re-read → send → poll → canonical receipt", async () => {
    const log: string[] = [];
    const { deps, sends } = makeDeps(log);
    const { jobId } = await seedLeg();

    await executeJob(deps, { jobId });

    const [row] = await execOf(jobId);
    expect(row.status).toBe("finished");
    expect(row.receiptText).toBe(CANONICAL_RECEIPT);
    expect(row.uaTxId).toBe("UA-1");
    const qj = row.quoteJson as {
      quote: { transactionId: string };
      policy: { record: { txHash: string } };
      pollDeadlineAt: string;
      uaDetail: unknown;
      fill: { assetId: string; usd: number; qty: number | null };
    };
    expect(qj.quote.transactionId).toBe("UA-1");
    expect(qj.policy.record.txHash).toMatch(/^0xrecord/);
    expect(qj.pollDeadlineAt).toBeTruthy();
    expect(qj.uaDetail).toBeTruthy();
    // doc 12 additive: the normalized fill lands at finish so basis math
    // never re-derives it from raw payloads (qty from tokenChanges.incr).
    expect(qj.fill).toEqual({ assetId: "spyx", usd: 15, qty: 0.02411 });
    expect((row.feesJson as { total: number }).total).toBeCloseTo(0.14, 6);
    expect((await jobOf(jobId)).status).toBe("done");
    expect(sends).toHaveLength(0);

    // Ordering law: quote persisted before signing; recordExecution INCLUDED
    // before the UA send; send before polling.
    const at = (m: string) => log.indexOf(m);
    expect(at("ua.quote:persisted")).toBeLessThan(at("policy.staticRecord"));
    expect(at("policy.staticRecord")).toBeLessThan(at("policy.submitIntent:record"));
    expect(at("policy.submitIntent:record")).toBeLessThan(at("ua.sendQuoted"));
    expect(at("ua.sendQuoted")).toBeLessThan(at("ua.pollTx"));
  });

  it("contract-blocked (staticCall) → blocked receipt within one pass, no broadcast, no refund", async () => {
    const log: string[] = [];
    const { deps, policy } = makeDeps(log);
    policy.staticResult = { ok: false, reason: "OverPeriodCap" };
    const { jobId } = await seedLeg();

    await executeJob(deps, { jobId });

    const [row] = await execOf(jobId);
    expect(row.status).toBe("blocked");
    expect(row.receiptText).toBe("Blocked: exceeds your $50 weekly cap");
    expect((await jobOf(jobId)).status).toBe("done");
    expect(log).not.toContain("policy.prepareRecord"); // nothing broadcast
    expect(log).not.toContain("policy.prepareRefund"); // never refund a block
    expect(log).not.toContain("ua.sendQuoted");
    expect(await eventOf(jobId, "execution.blocked")).toHaveLength(1);
  });

  it("courtesy preflight blocks over-cap legs before even quoting", async () => {
    const log: string[] = [];
    const { deps, policy } = makeDeps(log);
    policy.capPerExec = 10_000_000n; // $10 < the $15 leg
    const { jobId } = await seedLeg();

    await executeJob(deps, { jobId });

    const [row] = await execOf(jobId);
    expect(row.status).toBe("blocked");
    expect(row.receiptText).toBe("Blocked: exceeds your $10 per-trade cap");
    expect(log).not.toContain("ua.quote");
    expect(log).not.toContain("policy.staticRecord");
  });

  it("revoke-mid-flight: recorded but never sent — refund, honest receipt, job skipped", async () => {
    const log: string[] = [];
    const { deps, policy } = makeDeps(log);
    // Active at step 1, Revoked at the step-5 re-read.
    policy.planStatuses = [0, 2];
    const { jobId } = await seedLeg();

    await executeJob(deps, { jobId });

    const [row] = await execOf(jobId);
    expect(row.status).toBe("refunded");
    expect(row.receiptText).toBe(
      "Cancelled — this plan was revoked before your $15.00 SPYx buy went out",
    );
    expect((await jobOf(jobId)).status).toBe("skipped");
    expect(log).not.toContain("ua.sendQuoted"); // NEVER send after a revoke
    const at = (m: string) => log.indexOf(m);
    expect(at("policy.submitIntent:record")).toBeLessThan(at("policy.prepareRefund"));
    expect(log).toContain("policy.submitIntent:refund");
  });

  it("kill-mid-poll resume: submitted rows poll only — zero duplicate sends", async () => {
    const log: string[] = [];
    const { deps } = makeDeps(log);
    const { jobId } = await seedLeg({ jobStatus: "running" });
    await db.insert(executions).values({
      jobId,
      status: "submitted",
      uaTxId: "UA-9",
      receiptText: "",
      quoteJson: {
        attempt: 1,
        quote: quoteFixture("UA-9"),
        policy: { record: { kind: "record", nonce: 1, txHash: "0xr", raw: "0x", chainId: 42161 } },
        pollDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    await executeJob(deps, { jobId });

    const [row] = await execOf(jobId);
    expect(row.status).toBe("finished");
    expect(row.uaTxId).toBe("UA-9");
    expect(log).not.toContain("ua.quote");
    expect(log).not.toContain("ua.sendQuoted"); // the idempotency proof
    expect(log).not.toContain("policy.prepareRecord");
    expect((await jobOf(jobId)).status).toBe("done");
  });

  it("recorded resume: send-evidence probe finds the tx → adopt + poll, no re-send", async () => {
    const log: string[] = [];
    const { deps, ua } = makeDeps(log);
    ua.probeScript = [true];
    const { jobId } = await seedLeg({ jobStatus: "running" });
    await db.insert(executions).values({
      jobId,
      status: "recorded",
      receiptText: "",
      quoteJson: {
        attempt: 1,
        quote: quoteFixture("UA-7"),
        policy: { record: { kind: "record", nonce: 1, txHash: "0xr", raw: "0x", chainId: 42161 } },
      },
    });

    await executeJob(deps, { jobId });

    const [row] = await execOf(jobId);
    expect(row.status).toBe("finished");
    expect(row.uaTxId).toBe("UA-7");
    expect(log).toContain("ua.probe");
    expect(log).not.toContain("ua.sendQuoted");
    expect(log).not.toContain("policy.staticRecord"); // step 4 never re-runs
  });

  it("recorded resume: probe not-found → fresh quote, send WITHOUT re-recording", async () => {
    const log: string[] = [];
    const { deps, ua } = makeDeps(log);
    ua.probeScript = [false, false, false];
    ua.quoteId = "UA-8";
    const { jobId } = await seedLeg({ jobStatus: "running" });
    await db.insert(executions).values({
      jobId,
      status: "recorded",
      receiptText: "",
      quoteJson: {
        attempt: 1,
        quote: quoteFixture("UA-old"),
        policy: { record: { kind: "record", nonce: 1, txHash: "0xr", raw: "0x", chainId: 42161 } },
      },
    });

    await executeJob(deps, { jobId });

    const [row] = await execOf(jobId);
    expect(row.status).toBe("finished");
    expect(row.uaTxId).toBe("UA-8"); // the FRESH quote's id — stale never reused
    expect(log.filter((l) => l === "ua.probe")).toHaveLength(3);
    expect(log.filter((l) => l === "ua.sendQuoted")).toHaveLength(1);
    expect(log).not.toContain("policy.prepareRecord"); // already recorded
    expect(log).not.toContain("policy.staticRecord");
  });

  it("failure ladder: refund BEFORE each retry; 30/120/600; exhaustion → failed-refunded receipt", async () => {
    const log: string[] = [];
    const { deps, ua, sends } = makeDeps(log);
    ua.sendError = new Error("UA rejected the signature (forced)");
    const { jobId, periodKey } = await seedLeg();

    // Attempt 1 + the three retries — the ladder exactly.
    for (const [i, delay] of [30, 120, 600].entries()) {
      log.length = 0;
      await executeJob(deps, { jobId });
      const at = (m: string) => log.indexOf(m);
      expect(at("policy.prepareRefund")).toBeGreaterThan(-1);
      expect(at("policy.submitIntent:refund")).toBeLessThan(
        at(`boss.send:${periodKey}#a${i + 1}`),
      ); // refundExecution BEFORE scheduling the retry
      const send = sends[sends.length - 1];
      expect(send.opts.singletonKey).toBe(`${periodKey}#a${i + 1}`);
      expect(send.opts.startAfter).toBe(delay);
      const rows = await execOf(jobId);
      expect(rows[rows.length - 1].status).toBe("refunded");
      expect(rows[rows.length - 1].receiptText).toBe(""); // mid-ladder marker
    }

    // Attempt 4 fails → exhausted.
    log.length = 0;
    await executeJob(deps, { jobId });
    const rows = await execOf(jobId);
    expect(rows).toHaveLength(1 + MAX_RETRIES); // one row per attempt
    const final = rows[rows.length - 1];
    expect(final.status).toBe("refunded");
    expect(final.receiptText).toBe("Didn't complete — your $15.00 was returned");
    expect((await jobOf(jobId)).status).toBe("skipped");
    expect(sends).toHaveLength(3); // no fourth retry
    expect(await eventOf(jobId, "execution.failed")).toHaveLength(1);
  });

  it("UA REFUND statuses (8–11) walk the same refund-then-retry ladder", async () => {
    const log: string[] = [];
    const { deps, ua, sends } = makeDeps(log);
    ua.pollScript = [{ outcome: "refunded", t: { status: 9 } as never }];
    const { jobId, periodKey } = await seedLeg();

    await executeJob(deps, { jobId });

    const [row] = await execOf(jobId);
    expect(row.status).toBe("refunded");
    expect(row.receiptText).toBe("");
    expect(log).toContain("policy.prepareRefund");
    expect(sends[0].opts.singletonKey).toBe(`${periodKey}#a1`);
    expect(sends[0].opts.startAfter).toBe(30);
  });

  it("insufficient buying power: skip-and-notify with the canonical sentence + top-up event", async () => {
    const log: string[] = [];
    const { deps, ua } = makeDeps(log);
    ua.buyingPower = 3.02; // needed = 15 + 0.14 → $12.12 short
    const { jobId } = await seedLeg({ topUpOptIn: true });

    await executeJob(deps, { jobId });

    const [row] = await execOf(jobId);
    expect(row.status).toBe("failed");
    expect(row.receiptText).toBe(
      "Skipped this week's $15.00 SPYx buy — your buying power was $12.12 short. I'll try again next period.",
    );
    expect((await jobOf(jobId)).status).toBe("skipped");
    expect(log).not.toContain("policy.staticRecord"); // skipped BEFORE the chain
    expect(log).not.toContain("policy.prepareRefund"); // nothing recorded → no refund
    const [event] = await eventOf(jobId, "execution.skipped");
    const payload = event.payloadJson as { topUpOptIn: boolean; shortUsd: number };
    expect(payload.topUpOptIn).toBe(true); // doc 12 renders the opt-in card
    expect(payload.shortUsd).toBeCloseTo(12.12, 2);
  });

  it("S9: a persisted refund intent is reconciled, never re-fired (no double refund)", async () => {
    const log: string[] = [];
    const { deps, sends } = makeDeps(log);
    const { jobId, periodKey } = await seedLeg({ jobStatus: "running" });
    await db.insert(executions).values({
      jobId,
      status: "recorded",
      receiptText: "",
      quoteJson: {
        attempt: 1,
        cause: "send-error",
        quote: quoteFixture("UA-5"),
        policy: {
          record: { kind: "record", nonce: 1, txHash: "0xr", raw: "0x", chainId: 42161 },
          refund: { kind: "refund", nonce: 2, txHash: "0xf", raw: "0x", chainId: 42161 },
        },
      },
    });

    await executeJob(deps, { jobId });

    expect(log).toContain("policy.reconcileIntent:refund");
    expect(log).not.toContain("policy.prepareRefund"); // no second refund tx
    // The interrupted ladder resumes: retry #a1 scheduled.
    expect(sends[0].opts.singletonKey).toBe(`${periodKey}#a1`);
  });

  it("advisory-lock loser exits without touching anything", async () => {
    const log: string[] = [];
    const { deps } = makeDeps(log);
    const { jobId, periodKey } = await seedLeg();

    const holder = await getPool().connect();
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [periodKey]);
    try {
      await executeJob(deps, { jobId });
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        periodKey,
      ]);
      holder.release();
    }

    expect(log.filter((l) => l.startsWith("policy.") || l.startsWith("ua."))).toEqual([]);
    expect(await execOf(jobId)).toHaveLength(0);
    expect((await jobOf(jobId)).status).toBe("pending"); // untouched
  });

  it("rogue: $500 memecoin fails at step 4 onchain → blocked receipt through the real machinery", async () => {
    const log: string[] = [];
    const { deps, policy } = makeDeps(log);
    policy.staticResult = { ok: false, reason: "OverExecCap" };
    const { jobId } = await seedLeg({ rogue: true });

    await executeJob(deps, { jobId });

    const [row] = await execOf(jobId);
    expect(row.status).toBe("blocked");
    expect(row.receiptText).toBe("Blocked: exceeds your $50 per-trade cap");
    expect((row.quoteJson as { rogue: { usd: number } }).rogue.usd).toBe(ROGUE_USD);
    expect((await jobOf(jobId)).status).toBe("done");
    expect(log).not.toContain("ua.quote"); // no quote exists for a fake asset
    expect(await eventOf(jobId, "execution.blocked")).toHaveLength(1);
  });

  it("rogue safety: if the gate unexpectedly passes, nothing is broadcast", async () => {
    const log: string[] = [];
    const { deps, policy } = makeDeps(log);
    policy.staticResult = { ok: true };
    const { jobId } = await seedLeg({ rogue: true });

    await executeJob(deps, { jobId });

    const [row] = await execOf(jobId);
    expect(row.status).toBe("failed");
    expect(log).not.toContain("policy.prepareRecord");
    expect(log).not.toContain("policy.submitIntent:record");
    expect((await jobOf(jobId)).status).toBe("failed");
  });

  it("poll ceiling exceeded → unresolved receipt, NO refund, human-flagged", async () => {
    const log: string[] = [];
    const { deps } = makeDeps(log);
    const { jobId } = await seedLeg({ jobStatus: "running" });
    await db.insert(executions).values({
      jobId,
      status: "submitted",
      uaTxId: "UA-STUCK",
      receiptText: "",
      quoteJson: {
        attempt: 1,
        quote: quoteFixture("UA-STUCK"),
        pollDeadlineAt: new Date(Date.now() - 1_000).toISOString(), // already past
      },
    });

    await executeJob(deps, { jobId });

    const [row] = await execOf(jobId);
    expect(row.status).toBe("failed");
    expect(row.receiptText).toBe(
      "Still settling — your $15.00 SPYx buy hasn't confirmed yet. We're checking on it.",
    );
    expect(log).not.toContain("policy.prepareRefund"); // cap-deflation guard
    expect((await jobOf(jobId)).status).toBe("failed");
    expect(await eventOf(jobId, "execution.unresolved")).toHaveLength(1);
  });

  it("plan revoked before anything recorded → blocked NotActive, no refund", async () => {
    const log: string[] = [];
    const { deps } = makeDeps(log);
    const { jobId } = await seedLeg({ planStatus: "revoked" });

    await executeJob(deps, { jobId });

    const [row] = await execOf(jobId);
    expect(row.status).toBe("blocked");
    expect(row.receiptText).toBe("Blocked: this plan is no longer active");
    expect((await jobOf(jobId)).status).toBe("skipped");
    expect(log).not.toContain("policy.prepareRefund");
  });
});

describe("extractFundingSources (unfrozen UA payload — tolerant)", () => {
  it("prefers detail depositTokens, deduped in order", () => {
    expect(
      extractFundingSources(
        {
          depositTokens: [
            { token: { chainId: 8453 } },
            { token: { chainId: 42161 } },
            { token: { chainId: 8453 } },
          ],
        },
        undefined,
      ),
    ).toEqual(["Base", "Arbitrum"]);
  });
  it("falls back to quote userOps chain ids", () => {
    expect(
      extractFundingSources(undefined, { userOps: [{ chainId: 101 }, { chainId: 1 }] }),
    ).toEqual(["Solana", "Ethereum"]);
  });
  it("returns [] when nothing is extractable (receipt falls back gracefully)", () => {
    expect(extractFundingSources({ weird: true }, null)).toEqual([]);
  });
});
