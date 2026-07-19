import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetTicksForTests,
  createHealth,
  markTick,
  markTickError,
  type CronSpec,
  type HealthSources,
} from "./health";

const T0 = 1_800_000_000_000;

function sources(over: Partial<HealthSources> = {}): HealthSources {
  const cron = (o: Partial<CronSpec> = {}): CronSpec => ({
    enabled: true,
    everySecs: 60,
    ...o,
  });
  return {
    boss: { getQueue: async () => queueRow() },
    queueName: "execute",
    demoMode: false,
    release: "abc123",
    agent: { kind: "kms", address: "0x5629" },
    crons: {
      scheduler: cron(),
      snapshots: cron({ everySecs: 3_600 }),
      heartbeat: cron({ everySecs: 300 }),
      keeper: cron({ everySecs: 120 }),
    },
    bootedAt: T0,
    provider: { getBlockNumber: async () => 391_827_364 } as never,
    now: () => T0,
    ...over,
  };
}

const queueRow = (o = {}) => ({
  readyCount: 0,
  activeCount: 1,
  deferredCount: 2,
  failedCount: 0,
  totalCount: 143,
  updatedOn: new Date(T0),
  ...o,
});

beforeEach(__resetTicksForTests);

describe("cron liveness", () => {
  it("is healthy right after a tick", async () => {
    markTick("scheduler", T0);
    markTick("snapshots", T0);
    markTick("heartbeat", T0);
    markTick("keeper", T0);
    const body = await createHealth(sources({ now: () => T0 + 1_000 })).collect();
    expect(body.ok).toBe(true);
    expect(body.degraded).toEqual([]);
  });

  // A cold start is not a stall: before a cron is even due, "never ticked" is
  // the only thing it could possibly report.
  it("tolerates a never-ticked cron while it is not yet due", async () => {
    const body = await createHealth(sources({ now: () => T0 + 90_000 })).collect(); // 1.5x
    expect(body.ok).toBe(true);
  });

  it("faults a cron that stopped firing (3 missed intervals)", async () => {
    markTick("scheduler", T0);
    const body = await createHealth(sources({ now: () => T0 + 200_000 })).collect();
    expect(body.ok).toBe(false);
    expect(body.degraded.join(" ")).toContain("cron scheduler");
  });

  it("faults a never-ticked cron once it is overdue", async () => {
    const body = await createHealth(sources({ now: () => T0 + 300_000 })).collect();
    expect(body.ok).toBe(false);
  });

  // A configured absence is not a failure — a degraded dev boot has no signer
  // and must not page as if the keeper crashed.
  it("reports a disabled cron with its reason and does not call it degraded", async () => {
    const s = sources({ now: () => T0 + 10_000_000 });
    s.crons.keeper = { enabled: false, everySecs: 120, note: "no escrow provider" };
    markTick("scheduler", T0 + 9_999_000);
    markTick("snapshots", T0 + 9_999_000);
    markTick("heartbeat", T0 + 9_999_000);
    const body = await createHealth(s).collect();
    expect((body.crons["keeper"] as Record<string, unknown>)["enabled"]).toBe(false);
    expect((body.crons["keeper"] as Record<string, unknown>)["note"]).toBe("no escrow provider");
    expect(body.degraded.join(" ")).not.toContain("keeper");
  });

  it("records a firing-but-failing cron distinctly from a stalled one", async () => {
    markTick("scheduler", T0);
    markTickError("scheduler", T0);
    const body = await createHealth(sources({ now: () => T0 + 1_000 })).collect();
    expect((body.crons["scheduler"] as Record<string, unknown>)["lastErrorAt"]).not.toBeNull();
    expect(body.ok).toBe(true); // still ticking — Sentry owns the failure itself
  });
});

describe("queue depth", () => {
  it("reports readyCount as the backlog, not queuedCount", async () => {
    // deferredCount 2 is our 30s/2m/10m retry ladder sitting in the future —
    // counting it as backlog would read as a scary non-zero on a healthy queue.
    const body = await createHealth(sources()).collect();
    expect(body.queue).toMatchObject({ ready: 0, active: 1, deferred: 2, error: null });
  });

  it("degrades, and does not throw, when the queue is missing", async () => {
    const body = await createHealth(
      sources({ boss: { getQueue: async () => null } }),
    ).collect();
    expect(body.ok).toBe(false);
    expect(String(body.queue["error"])).toContain("does not exist");
  });

  it("degrades when pg-boss throws rather than taking the endpoint down", async () => {
    const body = await createHealth(
      sources({
        boss: {
          getQueue: async () => {
            throw new Error("pool exhausted");
          },
        },
      }),
    ).collect();
    expect(body.ok).toBe(false);
    expect(String(body.queue["error"])).toContain("pool exhausted");
  });

  it("survives a boss with no introspection at all (test fakes)", async () => {
    const body = await createHealth(sources({ boss: {} })).collect();
    expect(body.ok).toBe(false);
    expect(String(body.queue["error"])).toContain("unavailable");
  });
});

describe("rpc reachability", () => {
  it("reports the block number when reachable", async () => {
    const body = await createHealth(sources()).collect();
    expect(body.rpc).toMatchObject({ reachable: true, blockNumber: 391_827_364 });
  });

  it("degrades on an unreachable RPC without throwing", async () => {
    const body = await createHealth(
      sources({
        provider: {
          getBlockNumber: async () => {
            throw new Error("ECONNREFUSED");
          },
        } as never,
      }),
    ).collect();
    expect(body.ok).toBe(false);
    expect(body.rpc["reachable"]).toBe(false);
  });

  // A monitor polling every 10s must not become an RPC load generator.
  it("caches for 30s so polling costs ~2 calls a minute", async () => {
    const getBlockNumber = vi.fn(async () => 1);
    let clock = T0;
    const health = createHealth(
      sources({ provider: { getBlockNumber } as never, now: () => clock }),
    );
    await health.collect();
    clock = T0 + 10_000;
    await health.collect();
    clock = T0 + 20_000;
    await health.collect();
    expect(getBlockNumber).toHaveBeenCalledTimes(1);

    clock = T0 + 31_000;
    await health.collect();
    expect(getBlockNumber).toHaveBeenCalledTimes(2);
  });

  it("times out a hanging RPC instead of hanging the health check", async () => {
    const health = createHealth(
      sources({
        provider: { getBlockNumber: () => new Promise(() => {}) } as never,
        now: () => Date.now(),
      }),
    );
    const body = await health.collect();
    expect(body.rpc["reachable"]).toBe(false);
    expect(String(body.rpc["error"])).toContain("timed out");
  }, 10_000);
});

describe("body", () => {
  it("carries the release, agent identity, and demo flag", async () => {
    const body = await createHealth(sources()).collect();
    expect(body).toMatchObject({
      service: "worker",
      release: "abc123",
      demoMode: false,
      agent: { available: true, kind: "kms", address: "0x5629" },
    });
  });

  it("degrades on a boot with no agent signer", async () => {
    markTick("scheduler", T0);
    markTick("snapshots", T0);
    markTick("heartbeat", T0);
    markTick("keeper", T0);
    const body = await createHealth(sources({ agent: null, now: () => T0 + 1_000 })).collect();
    expect(body.ok).toBe(false);
    expect(body.degraded.join(" ")).toContain("agent signer unavailable");
  });
});
