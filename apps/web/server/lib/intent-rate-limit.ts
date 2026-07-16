// Intent-parse rate limit (doc 09, PROPOSED: 10 parses/min/user) — cost and
// abuse control for the one route that spends model tokens.
//
// Per-instance in-memory sliding window, the module-06 summaryCache precedent:
// fine for dev/demo and Vercel warm instances; a multi-instance deploy simply
// rate-limits per instance (module 17 may move it to a shared store if it
// ever matters). Not a security boundary — the schema wall and the signature
// gate downstream are.

export const INTENT_RATE_LIMIT = 10;
export const INTENT_RATE_WINDOW_MS = 60_000;

const hits = new Map<string, number[]>();

/** True when this parse is allowed (and recorded); false when over the limit. */
export function takeIntentParseSlot(userId: string, now = Date.now()): boolean {
  const fresh = (hits.get(userId) ?? []).filter(
    (t) => now - t < INTENT_RATE_WINDOW_MS,
  );
  if (fresh.length >= INTENT_RATE_LIMIT) {
    hits.set(userId, fresh);
    return false;
  }
  fresh.push(now);
  hits.set(userId, fresh);

  // Opportunistic sweep so idle users don't accumulate forever.
  if (hits.size > 10_000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= INTENT_RATE_WINDOW_MS)) hits.delete(key);
    }
  }
  return true;
}

/** Test seam. */
export function __resetIntentRateLimit(): void {
  hits.clear();
}
