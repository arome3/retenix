// Telemetry write-rate limit (doc 17, PS-8.2) — the intent-rate-limit shape.
//
// COST CONTROL, NOT A SECURITY BOUNDARY. The boundary is that the router maps a
// closed surface enum to a server-side event type and takes user_id from the
// session, so no caller can choose what gets written. This exists so the
// per-write `not exists` guard query cannot be hammered.
//
// Per-instance in-memory sliding window (the module-06 summaryCache precedent):
// a multi-instance deploy simply limits per instance, which for a metric that
// is already bounded to |surfaces|+1 rows per session is entirely adequate.

export const TELEMETRY_RATE_LIMIT = 30;
export const TELEMETRY_RATE_WINDOW_MS = 60_000;

const hits = new Map<string, number[]>();

/** True when this write is allowed (and recorded); false when over the limit. */
export function takeTelemetrySlot(userId: string, now = Date.now()): boolean {
  const fresh = (hits.get(userId) ?? []).filter(
    (t) => now - t < TELEMETRY_RATE_WINDOW_MS,
  );
  if (fresh.length >= TELEMETRY_RATE_LIMIT) {
    hits.set(userId, fresh);
    return false;
  }
  fresh.push(now);
  hits.set(userId, fresh);

  if (hits.size > 10_000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= TELEMETRY_RATE_WINDOW_MS)) hits.delete(key);
    }
  }
  return true;
}

/** Test seam. */
export function __resetTelemetryRateLimit(): void {
  hits.clear();
}
