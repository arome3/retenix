// Shared worker context + the narrow structural interfaces the scheduler
// and executor are written against (repo test convention: inject fakes
// through minimal types, never mock modules).

import type { Db } from "@retenix/db";

import type { AgentSigner } from "./kms";
import type { PolicyClient } from "./policy";

/** The one pg-boss queue; created with policy "exclusive" at boot — the
 *  default "standard" policy has NO singleton index and would silently
 *  ignore singletonKey (verified against pg-boss 12.25.1). */
export const EXECUTE_QUEUE = "execute";

/** Business retry ladder (PROPOSED, doc 08): seconds before attempts 2–4.
 *  Distinct from pg-boss's own retryLimit, which only covers crashes. */
export const RETRY_BACKOFF_SECS = [30, 120, 600] as const;
export const MAX_ATTEMPTS = RETRY_BACKOFF_SECS.length; // 3 retries after attempt 1

/** Minimal pg-boss surface the worker logic needs (fakes in tests). */
export interface BossLike {
  send(
    name: string,
    data: object,
    options: { singletonKey: string; startAfter?: number },
  ): Promise<string | null>;
}

export interface WorkerCtx {
  db: Db;
  boss: BossLike;
  agent: AgentSigner;
  policy: PolicyClient;
  demoMode: boolean;
}
