// Readiness / diagnostics surface (doc 17 §Observability: "worker exposes
// /internal/health (queue depth, last cron tick, RPC reachability)").
//
// THE SPLIT, and why it is not a rename. `GET /healthz` already exists and stays
// exactly as it is: dependency-free, unauthenticated, and the target of
// Railway's deploy probe — which cannot send an Authorization header. This is
// the authenticated diagnostic that actually touches pg-boss, the crons, and an
// RPC. Serving both from one endpoint would mean either handing an unauthorised
// caller a map of our queue depth and provider reachability, or handing Railway
// a probe it cannot authenticate against.
//
// Also load-bearing, and easy to "fix" by accident: startHttp runs LAST in
// index.ts, after boss.start(), createQueue, boss.work and every cron. That
// ordering makes /healthz an accidental readiness gate — Railway will not
// promote a deployment whose database is unreachable, whose pg-boss migration
// failed, or (in production) whose agent signer did not resolve. Do not move it
// earlier to "start serving sooner".
//
// EVERY PROBE IS TIME-BOXED AND CACHED. A health check that a sick dependency
// can hang is a second outage, not a signal: the endpoint must answer even when
// Postgres is wedged and the RPC is dark.

import { JsonRpcProvider } from "ethers";

import { env } from "../env";

export type CronName = "scheduler" | "snapshots" | "heartbeat" | "keeper";

interface Tick {
  lastTickAt: number | null;
  lastErrorAt: number | null;
}

const ticks: Record<CronName, Tick> = {
  scheduler: { lastTickAt: null, lastErrorAt: null },
  snapshots: { lastTickAt: null, lastErrorAt: null },
  heartbeat: { lastTickAt: null, lastErrorAt: null },
  keeper: { lastTickAt: null, lastErrorAt: null },
};

/** Called on cron ENTRY — proves the timer fired, independent of the outcome. */
export function markTick(name: CronName, now: number = Date.now()): void {
  ticks[name].lastTickAt = now;
}

/**
 * Called when a tick throws. Recorded separately from lastTickAt on purpose: a
 * cron that fires and always fails is a different fault from a cron that
 * stopped firing, and Sentry already has the first one.
 */
export function markTickError(name: CronName, now: number = Date.now()): void {
  ticks[name].lastErrorAt = now;
}

/** Test seam — the house `__reset*` convention. */
export function __resetTicksForTests(): void {
  for (const key of Object.keys(ticks) as CronName[]) {
    ticks[key] = { lastTickAt: null, lastErrorAt: null };
  }
}

// ---------------------------------------------------------------------------

/** The pg-boss surface this needs; optional so the worker's test fakes stay valid. */
export interface QueueStatsSource {
  getQueue?(name: string): Promise<{
    readyCount: number;
    activeCount: number;
    deferredCount: number;
    failedCount: number;
    totalCount: number;
    updatedOn?: Date;
  } | null>;
}

export interface CronSpec {
  enabled: boolean;
  everySecs: number;
  /** Why it is off, when it is off — "disabled" without a reason is a mystery. */
  note?: string;
}

export interface HealthSources {
  boss: QueueStatsSource;
  queueName: string;
  demoMode: boolean;
  release: string | undefined;
  agent: { kind: string; address: string } | null;
  crons: Record<CronName, CronSpec>;
  bootedAt: number;
  /** Injectable for tests; defaults to a lazily-built Arbitrum provider. */
  provider?: JsonRpcProvider;
  now?: () => number;
}

export interface HealthBody {
  ok: boolean;
  service: "worker";
  release: string | undefined;
  environment: string;
  demoMode: boolean;
  uptimeSecs: number;
  agent: { available: boolean; kind: string | null; address: string | null };
  queue: Record<string, unknown>;
  crons: Record<string, unknown>;
  rpc: Record<string, unknown>;
  degraded: string[];
}

const PROBE_TIMEOUT_MS = 2_000;
const RPC_TTL_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function createHealth(sources: HealthSources): {
  collect(): Promise<HealthBody>;
  dispose(): void;
} {
  const now = sources.now ?? (() => Date.now());
  let ownProvider: JsonRpcProvider | null = null;
  let rpcCache: { at: number; value: Record<string, unknown> } | null = null;
  let rpcInFlight: Promise<Record<string, unknown>> | null = null;

  const provider = (): JsonRpcProvider => {
    if (sources.provider) return sources.provider;
    ownProvider ??= new JsonRpcProvider(env.RPC_URL_ARBITRUM, undefined, {
      staticNetwork: true, // skip ethers' eth_chainId detection round-trip
    });
    return ownProvider;
  };

  /** 30s TTL + single-flight: a monitor at any poll rate costs ~2 calls/min. */
  async function probeRpc(): Promise<Record<string, unknown>> {
    const at = now();
    if (rpcCache && at - rpcCache.at < RPC_TTL_MS) {
      return { ...rpcCache.value, ageSecs: Math.round((at - rpcCache.at) / 1000) };
    }
    if (rpcInFlight) return rpcInFlight;

    rpcInFlight = (async () => {
      const started = now();
      try {
        const blockNumber = await withTimeout(
          provider().getBlockNumber(),
          PROBE_TIMEOUT_MS,
          "rpc",
        );
        return { reachable: true, blockNumber, latencyMs: now() - started, ageSecs: 0 };
      } catch (err) {
        return {
          reachable: false,
          blockNumber: null,
          latencyMs: now() - started,
          error: message(err),
          ageSecs: 0,
        };
      }
    })()
      .then((value) => {
        rpcCache = { at: now(), value };
        return value;
      })
      .finally(() => {
        rpcInFlight = null;
      });

    return rpcInFlight;
  }

  async function probeQueue(): Promise<Record<string, unknown>> {
    if (!sources.boss.getQueue) {
      return { name: sources.queueName, error: "queue introspection unavailable" };
    }
    try {
      const q = await withTimeout(
        sources.boss.getQueue(sources.queueName),
        PROBE_TIMEOUT_MS,
        "queue",
      );
      if (!q) return { name: sources.queueName, error: "queue does not exist" };
      return {
        name: sources.queueName,
        // readyCount is the TRUE backlog: queuedCount includes future-dated
        // deferred jobs (our retry ladder is 30s/2m/10m), which would read as a
        // scary non-zero on a perfectly healthy queue.
        ready: q.readyCount,
        active: q.activeCount,
        deferred: q.deferredCount,
        failed: q.failedCount,
        total: q.totalCount,
        updatedOn: q.updatedOn?.toISOString() ?? null,
        error: null,
      };
    } catch (err) {
      return { name: sources.queueName, error: message(err) };
    }
  }

  function cronHealth(at: number): { report: Record<string, unknown>; degraded: string[] } {
    const uptimeSecs = Math.round((at - sources.bootedAt) / 1000);
    const report: Record<string, unknown> = {};
    const degraded: string[] = [];

    for (const [name, spec] of Object.entries(sources.crons) as [CronName, CronSpec][]) {
      const { lastTickAt, lastErrorAt } = ticks[name];
      const ageSecs = lastTickAt === null ? null : Math.round((at - lastTickAt) / 1000);

      // A cron that is off by configuration is not a fault. A cron that has
      // never ticked is only a fault once it has had time to: before then, we
      // are looking at a cold start, not a stall.
      const ok = !spec.enabled
        ? true
        : lastTickAt === null
          ? uptimeSecs < spec.everySecs * 2
          : (ageSecs ?? 0) <= spec.everySecs * 3;

      report[name] = {
        enabled: spec.enabled,
        everySecs: spec.everySecs,
        lastTickAt: lastTickAt === null ? null : new Date(lastTickAt).toISOString(),
        ageSecs,
        lastErrorAt: lastErrorAt === null ? null : new Date(lastErrorAt).toISOString(),
        ok,
        ...(spec.note ? { note: spec.note } : {}),
      };
      if (!ok) {
        degraded.push(
          `cron ${name} has not ticked in ${ageSecs ?? "?"}s (every ${spec.everySecs}s)`,
        );
      }
    }
    return { report, degraded };
  }

  return {
    async collect(): Promise<HealthBody> {
      const at = now();
      // Concurrent, and neither can reject — a failed probe is data, not an outage.
      const [queue, rpc] = await Promise.all([probeQueue(), probeRpc()]);
      const { report: crons, degraded } = cronHealth(at);

      if (!sources.agent) degraded.push("agent signer unavailable (degraded boot)");
      if (queue["error"]) degraded.push(`queue: ${String(queue["error"])}`);
      if (rpc["reachable"] === false) degraded.push(`rpc: ${String(rpc["error"] ?? "unreachable")}`);

      return {
        ok: degraded.length === 0,
        service: "worker",
        release: sources.release,
        environment: env.NODE_ENV ?? "development",
        demoMode: sources.demoMode,
        uptimeSecs: Math.round((at - sources.bootedAt) / 1000),
        agent: {
          available: sources.agent !== null,
          kind: sources.agent?.kind ?? null,
          address: sources.agent?.address ?? null,
        },
        queue,
        crons,
        rpc,
        degraded,
      };
    },
    dispose(): void {
      ownProvider?.destroy();
      ownProvider = null;
      rpcCache = null;
    },
  };
}
