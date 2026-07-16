// Observability seams (doc 08 / doc 17): Slack status webhook + Sentry +
// events rows. The worker's law is "nothing silent" — every terminal
// failure produces a Slack message AND an events row; both helpers are
// deliberately never-throw so an observability outage can't fail a
// pipeline step (the pipeline's own persistence is the source of truth).

import * as Sentry from "@sentry/node";
import { events, type Db } from "@retenix/db";

import { env } from "../env";

let sentryReady = false;

/** Init once at boot; a placeholder DSN just disables Sentry loudly. */
export function initSentry(): void {
  try {
    Sentry.init({ dsn: env.SENTRY_DSN, tracesSampleRate: 0 });
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
