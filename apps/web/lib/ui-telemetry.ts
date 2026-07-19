// PS-8.2 client instrumentation (doc 17 §Observability).
//
// The metric is "≥60% of sessions include zero chain-name exposure", so what is
// counted is a SESSION, not a render. Three layers of dedupe, cheapest first:
//
//   1. a module Set — kills every repeat within a page load with no storage
//      access and no request. This is what makes the hook safe to call from a
//      component that remounts on scroll, or twice under React StrictMode.
//   2. sessionStorage — survives a reload or a hard navigation within the tab.
//      This IS the definition of "session" here: per-tab, survives reload, dies
//      on tab close. Same substrate module 02 chose for the onboarding sid.
//   3. a server-side `not exists` guard (server/routers/telemetry.ts) — so a
//      client that ignores both still cannot multiply rows.
//
// Every storage access is wrapped: private mode degrades to layers 1 and 3
// rather than throwing (lib/gate.ts and lib/onboarding.ts set that convention).

import type { NamedSurface } from "@retenix/shared";

import { trpcTelemetry } from "@/lib/trpc-telemetry";
import { readOnboarding } from "@/lib/onboarding";

const SID_KEY = "retenix:sid";
const NAMED_KEY_PREFIX = "retenix:ui:named:";
const SESSION_KEY = "retenix:ui:session-started";

/** Already reported during THIS page load. */
const reportedThisLoad = new Set<string>();

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null; // private mode / storage disabled
  }
}

function write(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* private mode — layers 1 and 3 still hold */
  }
}

/**
 * This tab session's correlation id, minted on first use.
 *
 * Deliberately NOT the onboarding sid: `endOnboarding()` deletes that at
 * /ready, which is exactly when the app session begins. Different lifetime,
 * different key — but the onboarding sid is carried on the session-started
 * event so the PS-8.2 funnel and the PS-F1-AC1 warm-path funnel can be joined.
 */
export function sessionId(): string {
  const existing = read(SID_KEY);
  if (existing) return existing;
  const sid = crypto.randomUUID();
  write(SID_KEY, sid);
  return sid;
}

/** Fire-and-forget. A rejection here must never surface into React. */
function send(run: () => Promise<unknown>): void {
  void run().catch(() => undefined);
}

/**
 * Report that `surface` put a source's proper name on screen.
 * Idempotent per (tab session, surface). Returns whether this call reported.
 */
export function reportNamed(surface: NamedSurface): boolean {
  const loadKey = `named:${surface}`;
  if (reportedThisLoad.has(loadKey)) return false;

  const storageKey = `${NAMED_KEY_PREFIX}${surface}`;
  if (read(storageKey)) {
    reportedThisLoad.add(loadKey);
    return false;
  }

  reportedThisLoad.add(loadKey);
  write(storageKey, "1");
  const sid = sessionId();
  send(() => trpcTelemetry.telemetry.sourceNamed.mutate({ sid, surface }));
  return true;
}

/** Report that a session began. Idempotent per tab session. */
export function reportSessionStart(): boolean {
  if (reportedThisLoad.has("session")) return false;
  reportedThisLoad.add("session");

  if (read(SESSION_KEY)) return false;
  write(SESSION_KEY, "1");

  const sid = sessionId();
  const { sid: onboardingSid } = readOnboarding();
  send(() =>
    trpcTelemetry.telemetry.sessionStarted.mutate({
      sid,
      onboardingSid: onboardingSid ?? null,
    }),
  );
  return true;
}

/** Test seam — the house `__reset*` convention. */
export function __resetUiTelemetry(): void {
  reportedThisLoad.clear();
}
