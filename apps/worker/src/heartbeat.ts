// Cross-network heartbeat (doc 14, tech spec §9): per enrolled owner, observe
// UA activity via getTransactions; NEW activity since the last observation ⇒
// relay checkIn(owner) on Arbitrum. The relayed call is relayer-gated onchain
// (CONFLICTS #13) — this module IS the provenance verification: it relays
// only after confirming observed activity, and the observation evidence is
// stored on the estate.checkin event. Trust note (CONFLICTS #13, verbatim
// intent): a rogue bump only PROTECTS the owner — it griefs the heir's
// timeline, it can never move funds.
//
// The Alchemy webhook (webhooks.ts) may request an immediate observation for
// one owner — UX freshness only; the timer NEVER moves without this module's
// observation confirming real activity.
//
// Cadence (PROPOSED): every 5 minutes; every 20 seconds in DEMO_MODE (the
// 120-second demo inactivity window needs sub-minute observation).
import {
  ESTATE_EVENTS,
  estateCheckinObservedReceipt,
  estateCountdownStartedReceipt,
  estateStatusName,
} from "@retenix/shared";
import { estates, type Db } from "@retenix/db";
import { eq } from "drizzle-orm";

import { captureError, recordEvent } from "./notify";
import {
  enrolledEstates,
  type EnrolledEstate,
  type EstateOnchain,
} from "./estate-support";

export const HEARTBEAT_CRON_PROD = "*/5 * * * *";
export const HEARTBEAT_CRON_DEMO = "*/20 * * * * *";

/** Injectable observation source — production wraps @retenix/ua
 *  getTransactions; tests inject payload fixtures. */
export interface ActivityObserver {
  /** Raw getTransactions payload for the owner's UA (shape unfrozen — OQ5's
   *  sibling; parsed defensively below). */
  recentActivity(owner: string): Promise<unknown>;
}

export interface HeartbeatDeps {
  db: Db;
  onchain: EstateOnchain;
  observer: ActivityObserver;
  now?: () => number;
}

/**
 * Defensive timestamp extraction from the UNFROZEN getTransactions payload:
 * accepts an array (or the usual wrapper keys), reads the common time fields,
 * normalizes seconds→ms. Anything unrecognized contributes nothing — a
 * misparse can only UNDER-report activity (missed bump, safe direction:
 * Chainlink still guards the deadline and the owner has "I'm here").
 */
export function extractActivityTimes(payload: unknown): number[] {
  const wrapper = payload as Record<string, unknown> | unknown[] | null | undefined;
  const list: unknown[] = Array.isArray(wrapper)
    ? wrapper
    : wrapper && typeof wrapper === "object"
      ? ((): unknown[] => {
          for (const key of ["transactions", "list", "data", "items", "records"]) {
            const v = (wrapper as Record<string, unknown>)[key];
            if (Array.isArray(v)) return v;
            if (v && typeof v === "object") {
              for (const inner of ["transactions", "list", "items"]) {
                const w = (v as Record<string, unknown>)[inner];
                if (Array.isArray(w)) return w;
              }
            }
          }
          return [];
        })()
      : [];

  const times: number[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    for (const key of ["createdAt", "updatedAt", "timestamp", "time", "createdTimestamp"]) {
      const v = rec[key];
      let ms: number | null = null;
      if (typeof v === "number" && Number.isFinite(v)) {
        ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
      } else if (typeof v === "string" && v) {
        const parsed = Date.parse(v);
        if (!Number.isNaN(parsed)) ms = parsed;
        else if (/^\d+$/.test(v)) {
          const n = Number(v);
          ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : null;
        }
      }
      if (ms !== null) {
        times.push(ms);
        break;
      }
    }
  }
  return times;
}

interface CacheShape {
  status?: string;
  lastObservedTxAt?: string | null;
  demoScaled?: boolean;
  [k: string]: unknown;
}

/** Observe ONE owner; relay a check-in when new activity appears. Exported so
 *  the Alchemy webhook can trigger an immediate cycle for a single owner. */
export async function observeOwner(
  deps: HeartbeatDeps,
  estate: EnrolledEstate,
): Promise<{ relayed: boolean }> {
  const now = deps.now ? deps.now() : Date.now();
  const chain = await deps.onchain.estateOf(estate.owner);
  const statusName = estateStatusName(chain.status);
  const cache = (estate.contractStateCache ?? {}) as CacheShape;

  // countdown observation (C8's backend truth) — record once per transition
  if ((statusName === "countdown" || statusName === "claimable") && cache.status === "enrolled") {
    await recordEvent(deps.db, ESTATE_EVENTS.countdownStarted, estate.userId, {
      kind: "legacy",
      receipt: estateCountdownStartedReceipt(),
      claimReadyAt: new Date(Number(chain.claimReadyAt) * 1000).toISOString(),
    });
  }

  let relayed = false;
  let watermark = cache.lastObservedTxAt ?? null;
  if (statusName === "enrolled" || statusName === "countdown" || statusName === "claimable") {
    try {
      const payload = await deps.observer.recentActivity(estate.owner);
      const times = extractActivityTimes(payload);
      const newest = times.length > 0 ? Math.max(...times) : null;
      const prior = watermark ? Date.parse(watermark) : null;
      if (newest !== null && (prior === null || newest > prior)) {
        // observed NEW activity — the provenance CONFLICTS #13 requires;
        // one relayed call bumps lastCheckIn (and cancels a countdown)
        const { txHash } = await deps.onchain.checkIn(estate.owner);
        relayed = true;
        watermark = new Date(newest).toISOString();
        await recordEvent(deps.db, ESTATE_EVENTS.checkin, estate.userId, {
          kind: "legacy",
          receipt: estateCheckinObservedReceipt("your account"),
          source: "observed",
          txHash,
          proof: { observedActivityAt: watermark, observedCount: times.length },
        });
      }
    } catch (err) {
      captureError(err, { while: "heartbeat-observe", owner: estate.owner });
    }
  }

  // refresh the cache (C8's serve-stale fallback reads this)
  const lastCheckIn = relayed
    ? new Date(now)
    : chain.lastCheckIn === 0n
      ? null
      : new Date(Number(chain.lastCheckIn) * 1000);
  const effectiveStatus =
    relayed && (statusName === "countdown" || statusName === "claimable")
      ? "enrolled"
      : statusName;
  await deps.db
    .update(estates)
    .set({
      contractStateCache: {
        ...cache,
        status: effectiveStatus,
        lastCheckIn: lastCheckIn ? lastCheckIn.toISOString() : null,
        deadlineAt: lastCheckIn
          ? new Date(lastCheckIn.getTime() + Number(chain.inactivitySecs) * 1000).toISOString()
          : null,
        claimReadyAt:
          !relayed && chain.claimReadyAt !== 0n
            ? new Date(Number(chain.claimReadyAt) * 1000).toISOString()
            : null,
        inactivitySecs: Number(chain.inactivitySecs),
        demoScaled: cache.demoScaled ?? false,
        updatedAt: new Date(now).toISOString(),
        lastObservedTxAt: watermark,
      },
    })
    .where(eq(estates.userId, estate.userId));

  return { relayed };
}

/** The cron body: one observation cycle over every enrolled estate. */
export async function heartbeatTick(deps: HeartbeatDeps): Promise<void> {
  let rows: EnrolledEstate[];
  try {
    rows = await enrolledEstates(deps.db);
  } catch (err) {
    captureError(err, { while: "heartbeat-scan" });
    return;
  }
  for (const estate of rows) {
    try {
      await observeOwner(deps, estate);
    } catch (err) {
      captureError(err, { while: "heartbeat-owner", owner: estate.owner });
    }
  }
}
