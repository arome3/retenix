// Observability seams (doc 08 / doc 17): Slack status webhook + Sentry +
// events rows. The worker's law is "nothing silent" — every terminal
// failure produces a Slack message AND an events row; both helpers are
// deliberately never-throw so an observability outage can't fail a
// pipeline step (the pipeline's own persistence is the source of truth).
//
// This is the ONE notify module (doc 17: "one notify.ts helper — one module, no
// duplicates"). It owns the five trigger classes doc 17 enumerates:
//
//   1. execution terminal failure (post-retries)   — executor.ts
//   2. blocked receipts (informational)            — executor.ts
//   3. smoke result                                — mainnet-smoke.yml (see below)
//   4. keeper state changes (deadline fired,
//      claim executed)                             — keeper.ts
//   5. LINK-balance low                            — keeper.ts (doc 14)
//
// (3) runs in a GitHub runner, not this process, so the workflow restates the
// format in curl. `smokeResult()` below is the canonical shape the two agree on.

import * as Sentry from "@sentry/node";
import {
  resolveRelease,
  scrubBreadcrumb,
  scrubEvent,
} from "@retenix/shared/observability";
import { events, type Db } from "@retenix/db";

import { env } from "../env";

let sentryReady = false;

/** Init once at boot; a placeholder DSN just disables Sentry loudly. */
export function initSentry(): void {
  try {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      tracesSampleRate: 0,
      // doc 17: "Release = git SHA on both."
      release: resolveRelease({
        SENTRY_RELEASE: env.SENTRY_RELEASE,
        RAILWAY_GIT_COMMIT_SHA: env.RAILWAY_GIT_COMMIT_SHA,
      }),
      environment: env.NODE_ENV ?? "development",
      // doc 17 §Security: no emails, no signatures, no tuple material. The
      // scrubbers live in @retenix/shared/observability so web and worker
      // cannot drift — a deny-list that exists twice will.
      beforeSend: (event) => scrubEvent(event),
      beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
    });
    sentryReady = true;
  } catch (err) {
    console.warn(
      "[worker] Sentry disabled — DSN rejected:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** One breadcrumb per pipeline step (doc 08 task 8). */
export function breadcrumb(message: string, data?: Record<string, unknown>): void {
  if (!sentryReady) return;
  Sentry.addBreadcrumb({ category: "pipeline", level: "info", message, data });
}

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  console.error("[worker]", err instanceof Error ? err.message : err, context ?? "");
  if (!sentryReady) return;
  Sentry.captureException(err, { extra: context });
}

/** Post to the status webhook. Never throws; placeholder URLs no-op. */
export async function slack(text: string): Promise<void> {
  const url = env.SLACK_STATUS_WEBHOOK_URL;
  if (url.includes("PLACEHOLDER") || url.endsWith("/x")) {
    console.log(`[worker] slack (disabled): ${text}`);
    return;
  }
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    console.warn(
      "[worker] slack notify failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// Message shapes
//
// doc 17: "Every message links the execution row and the tx."
//
// The tx half is doc 03's activityUrl(uaTxId). The execution-row half is the
// executions.id UUID: doc 11's /activity screen takes no query parameter today,
// so there is no per-row deep link to hand out, and inventing one would mean
// changing a screen this module does not own. The UUID is what an operator
// actually needs — it is the primary key they will select on — so it is stated
// verbatim rather than dressed up as a link that would 404.
// ---------------------------------------------------------------------------

/** The row-and-tx suffix every money-path message carries. */
export function executionRef(ref: {
  executionId?: string | null;
  uaTxId?: string | null;
  planId?: string | null;
}): string {
  const parts: string[] = [];
  if (ref.executionId) parts.push(`execution \`${ref.executionId}\``);
  if (ref.planId) parts.push(`plan \`${ref.planId}\``);
  if (ref.uaTxId) parts.push(`https://universalx.app/activity/details?id=${ref.uaTxId}`);
  return parts.length ? ` — ${parts.join(" · ")}` : "";
}

/**
 * Trigger 3. Canonical smoke-result format. The daily convert runs in a GitHub
 * runner and cannot call this, so `.github/workflows/mainnet-smoke.yml` restates
 * it in curl — keep the two in step. Exported so a local drill can post the
 * exact shape the workflow would.
 */
export function smokeResult(ok: boolean, usd: string, runUrl: string): string {
  return ok
    ? `:white_check_mark: mainnet-smoke green — $${usd} convert FINISHED · ${runUrl}`
    : `:rotating_light: mainnet-smoke RED — $${usd} convert did not FINISH. ` +
        `STOP feature work, diagnose. · ${runUrl}`;
}

/**
 * Trigger 4a. The inactivity deadline fired for an estate — the moment the
 * challenge window starts and the owner can still cancel. Until now this was
 * only a console.log, which is invisible in production (doc 14: the countdown
 * must never be a surprise, and ops must know before the heir does).
 */
export async function keeperDeadlineFired(owner: string, txHash: string): Promise<void> {
  await slack(
    `:hourglass_flowing_sand: estate deadline FIRED for \`${owner}\` — ` +
      `challenge window open, owner can still cancel · tx \`${txHash}\``,
  );
}

/**
 * Trigger 5. Chainlink upkeep LINK balance is low (doc 14 §Open questions OQ6
 * requires the alert but fixes no threshold; RegisterUpkeep.md's >=5 LINK
 * starting deposit on One is the basis for the default of 2).
 *
 * If the upkeep runs dry the inactivity deadline stops firing, which is the one
 * failure this product is least allowed to have — so this is loud, and it
 * repeats rather than latching.
 */
export async function keeperLinkLow(balance: string, threshold: number): Promise<void> {
  await slack(
    `:warning: Chainlink upkeep LINK balance ${balance} is below ${threshold} — ` +
      `top up, or the inactivity deadline stops firing (doc 14).`,
  );
}

/**
 * Append an events row (doc 00 table). Worker event types (PROPOSED, doc 08
 * — modules 11/12 consume verbatim):
 *   execution.blocked | execution.skipped | execution.failed |
 *   execution.unresolved | plan.periods_missed | plan.params_invalid |
 *   job.resurrected | job.rescue_exhausted
 * execution.skipped carries { topUpOptIn } for doc 12's prompt card.
 */
export async function recordEvent(
  db: Db,
  type: string,
  userId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(events).values({ userId, type, payloadJson: payload });
  } catch (err) {
    captureError(err, { while: "recordEvent", type, payload });
  }
}
