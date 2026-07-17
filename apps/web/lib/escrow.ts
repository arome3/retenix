/*
 * The tuple ceremony (doc 14, browser, headless) — per estate chain: Magic
 * switches its selected endpoint, then signs a 7702 authorization delegating
 * to that chain's RetenixClaim, bound to the EOA's CURRENT account nonce
 * (server-read; the browser never touches RPC endpoints). The nonce binding
 * is the dead-man switch: any owner transaction voids the whole set, and this
 * ceremony re-runs silently on login to restore coverage (stale tuples are
 * the mechanism working, never an error).
 *
 * Order is load-bearing (module 02/03): switchChain BEFORE
 * sign7702Authorization, and the loop is STRICTLY SEQUENTIAL — the selected
 * chain is global mutable state inside Magic.
 */
import type { EscrowTuple } from "@retenix/shared";
import { magic } from "@/lib/magic";
import { trpcVanilla } from "@/lib/trpc-vanilla";

export interface CeremonyTarget {
  chainId: number;
  delegateAddress: string;
  nonce: number;
}

export async function signEscrowTuples(targets: CeremonyTarget[]): Promise<EscrowTuple[]> {
  const tuples: EscrowTuple[] = [];
  for (const target of targets) {
    await magic.evm.switchChain(target.chainId);
    const raw = await magic.wallet.sign7702Authorization({
      contractAddress: target.delegateAddress,
      chainId: target.chainId,
      nonce: target.nonce,
    });
    tuples.push({
      chainId: target.chainId,
      address: target.delegateAddress,
      nonce: target.nonce,
      // Magic returns v ∈ {27, 28} (G1's live introspection) or already 0/1
      yParity: (raw.v >= 27 ? raw.v - 27 : raw.v) as 0 | 1,
      r: raw.r,
      s: raw.s,
    });
  }
  return tuples;
}

/**
 * Silent coverage refresh — login and after any transacting session. Reads
 * fresh ceremony targets (live nonces), re-signs, re-escrows. Never throws,
 * never blocks (the post-login contract); not-enrolled is the common case
 * and exits quietly on the first query.
 */
export async function refreshEscrowCoverage(): Promise<void> {
  const { enrolled } = await trpcVanilla.estate.status.query();
  if (!enrolled) return;
  const prep = await trpcVanilla.estate.prepareEnroll.query();
  const tuples = await signEscrowTuples(prep.targets);
  await trpcVanilla.estate.refreshTuples.mutate({ tuples });
}

let refreshScheduled = false;

/** Debounced fire-and-forget wrapper — the runners (sweep/kill/sell) call
 *  this after a session transacted, since every send bumps a nonce somewhere
 *  and the escrow set is void until re-signed. */
export function scheduleTupleRefresh(): void {
  if (refreshScheduled) return;
  refreshScheduled = true;
  setTimeout(() => {
    refreshEscrowCoverage()
      .catch(() => {})
      .finally(() => {
        refreshScheduled = false;
      });
  }, 4_000);
}
