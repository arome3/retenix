// UA execution surface for one leg (doc 08).
//
// executeLegForUser is THE backend-authority seam (tech spec OQ3 / gate G3):
// the spec wants buys funded from the USER's any-chain balance, but UA
// v2.0.3 roots a transaction's signature in the account's ownerAddress, and
// how a backend agent key executes against a user-owned UA is exactly the
// open question G3 puts to Particle. Until it answers, this function binds
// the AGENT's own UA (doc 03 backend flow — works regardless); the model
// swaps INSIDE this one function. Do not let UA calls leak around it.
//
// Concurrency (OQ2 fallback): UA rate limits are undocumented → every UA
// network call in the worker flows through one p-queue capped at 2. The
// quote and the send take separate short slots — holding one slot across
// the onchain recordExecution wait could deadlock the pool at concurrency 2
// (both slots parked on nested queue.add calls). The record inclusion on
// Arbitrum is seconds, far inside a quote's validity window; create → sign
// → send still happens in one continuous in-memory flow (quotes are never
// persisted for later signing).

import PQueue from "p-queue";
import {
  createBuyTransaction,
  createUa,
  getPrimaryAssets,
  getTransaction,
  pollToTerminal,
  signAndSend,
  type ITransaction,
  type PollResult,
  type UaSigner,
  type UniversalAccount,
} from "@retenix/ua";

import { env } from "../env";
import type { AgentSigner } from "./kms";

export const UA_CONCURRENCY = 2;

/** Every UA network call in the worker goes through this queue (OQ2). */
export const uaQueue = new PQueue({ concurrency: UA_CONCURRENCY });

const run = <T>(fn: () => Promise<T>): Promise<T> => uaQueue.add(fn);

/** What the executor consumes; tests inject fakes of this shape. */
export interface UaLegExec {
  ownerAddress: string;
  /** Step 2: create the quote; `persist` runs BEFORE the function returns
   *  so the create-time transactionId is on disk before anything signs. */
  quote(
    token: { chainId: number; address: string },
    amountUsd: number,
    persist: (tx: ITransaction) => Promise<void>,
  ): Promise<ITransaction>;
  /** Step 5: sign + send the quote created moments ago (same process). */
  sendQuoted(tx: ITransaction): Promise<{ transactionId: string }>;
  /** Resume probe: was this create-time transactionId ever registered?
   *  Resolves {found:false} ONLY on a definitive not-found — ambiguous
   *  errors (network, 5xx) throw, because concluding "never sent" from an
   *  outage is the duplicate-buy path. */
  probeTransaction(transactionId: string): Promise<{ found: boolean; detail?: unknown }>;
  /** Step 6: poll to a terminal status (each tick takes one queue slot). */
  pollTx(transactionId: string, opts?: { timeoutMs?: number }): Promise<PollResult>;
  /** PS-F4.4 preflight input. */
  buyingPowerUsd(): Promise<number>;
}

const agentUaByOwner = new Map<string, UniversalAccount>();

function agentUa(agent: AgentSigner): UniversalAccount {
  let ua = agentUaByOwner.get(agent.address);
  if (!ua) {
    ua = createUa({
      ownerAddress: agent.address,
      credentials: {
        projectId: env.PARTICLE_PROJECT_ID,
        projectClientKey: env.PARTICLE_CLIENT_KEY,
        projectAppUuid: env.PARTICLE_APP_UUID,
      },
    });
    agentUaByOwner.set(agent.address, ua);
  }
  return ua;
}

/** The UA the worker warms at boot (doc 05 call site, now agent-signer-aware). */
export function agentUaFor(agent: AgentSigner): UniversalAccount {
  return agentUa(agent);
}

const NOT_FOUND_RE = /not.?found|404|no such|does not exist|invalid.*transaction.?id/i;

/** DEMO-gated fault injection (doc 08 failure rehearsal): corrupt the root
 *  signature's final byte so Particle rejects the send server-side — the
 *  honest failure ladder (refund → retry → skip) runs on mainnet without
 *  moving funds. Inert unless BOTH DEMO_MODE=1 and FAULT_INJECT_UA are set. */
function withFaultInjection(inner: UaSigner): UaSigner {
  if (env.DEMO_MODE !== "1" || env.FAULT_INJECT_UA !== "corrupt-root-sig") {
    return inner;
  }
  console.warn(
    "[worker] FAULT_INJECT_UA=corrupt-root-sig ACTIVE — every UA send will be rejected (rehearsal only)",
  );
  return {
    sign7702Auth: (a) => inner.sign7702Auth(a),
    async signRootHash(rootHash: string): Promise<string> {
      const sig = await inner.signRootHash(rootHash);
      const flipped = (Number.parseInt(sig.slice(-2), 16) ^ 0xff)
        .toString(16)
        .padStart(2, "0");
      return sig.slice(0, -2) + flipped;
    },
  };
}

/**
 * THE G3 seam. `plan`/`leg` are accepted (and today ignored) so the swap to
 * a user-UA model — delegated backend signing or a plan-scoped execution
 * balance — changes only this function's body, never its callers.
 */
export function executeLegForUser(
  _plan: { id: string; userId: string },
  _leg: { seq: number; assetId: string },
  agent: AgentSigner,
): UaLegExec {
  const ua = agentUa(agent);
  const signer: UaSigner = withFaultInjection(agent.uaSigner);

  return {
    ownerAddress: agent.address,

    async quote(token, amountUsd, persist) {
      const tx = await run(() =>
        createBuyTransaction(ua, {
          token,
          amountInUSD: String(amountUsd),
        }),
      );
      await persist(tx); // write-ahead: probe evidence before any signature
      return tx;
    },

    sendQuoted(tx) {
      return run(() => signAndSend(ua, tx, signer));
    },

    async probeTransaction(transactionId) {
      try {
        const detail = await run(() => getTransaction(ua, transactionId));
        if (detail == null) return { found: false };
        const status = (detail as { status?: unknown }).status;
        if (typeof status !== "number") return { found: false };
        return { found: true, detail };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (NOT_FOUND_RE.test(msg)) return { found: false };
        throw err; // ambiguous — the caller must NOT conclude "never sent"
      }
    },

    pollTx(transactionId, opts) {
      const source = {
        getTransaction: (id: string) => run(() => getTransaction(ua, id)),
      };
      return pollToTerminal(source as Parameters<typeof pollToTerminal>[0], transactionId, {
        intervalMs: 2_000,
        timeoutMs: opts?.timeoutMs ?? 180_000,
      });
    },

    async buyingPowerUsd() {
      const assets = await run(() => getPrimaryAssets(ua));
      return Number(assets.totalAmountInUSD ?? 0);
    },
  };
}
