// send.resolve rate limit (doc 15, PROPOSED — flagged in HANDOFF): the
// resolve preview is an email→"has an account?" oracle, so it gets the
// intent-parse treatment (per-instance in-memory sliding window; not a
// security boundary — resolve never returns an address for email lookups,
// and the signed authorize phase re-resolves everything).

export const SEND_RESOLVE_RATE_LIMIT = 20;
export const SEND_RESOLVE_RATE_WINDOW_MS = 60_000;

const hits = new Map<string, number[]>();

/** True when this resolve is allowed (and recorded); false when over. */
export function takeSendResolveSlot(userId: string, now = Date.now()): boolean {
  const fresh = (hits.get(userId) ?? []).filter(
    (t) => now - t < SEND_RESOLVE_RATE_WINDOW_MS,
  );
  if (fresh.length >= SEND_RESOLVE_RATE_LIMIT) {
    hits.set(userId, fresh);
    return false;
  }
  fresh.push(now);
  hits.set(userId, fresh);
  if (hits.size > 10_000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= SEND_RESOLVE_RATE_WINDOW_MS)) hits.delete(key);
    }
  }
  return true;
}

/** Test seam. */
export function __resetSendResolveRateLimit(): void {
  hits.clear();
}
