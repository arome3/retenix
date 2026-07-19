import { events, plans, type Db } from "@retenix/db";
import {
  SECURITY_EVENTS,
  planDismissedReceipt,
  revokeAllDigest,
  securityRevokeAllPayloadSchema,
  withSig,
  type DelegationsResult,
} from "@retenix/shared";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  buildDelegations,
  delegationsCache,
} from "../lib/delegations"; // copy-canon-allow (import specifier)
import { getPlanRelay } from "../lib/relay-factory";
import { gatedProcedure, protectedProcedure, router, signedProcedure } from "../trpc";

/*
 * C13 security surfaces (doc 15) — the live delegation panel and
 * revoke-all-WITHOUT-liquidation ("Dismiss all staff", the kill switch's
 * gentler sibling: authority dies, positions stay).
 *
 * Procedure classes follow kill's safety doctrine (module 13 deviation 9):
 * signed/protected, never gated — a safety surface must not 403 on gate
 * state. delegations is gated (asset-adjacent read, the account.summary
 * convention).
 *
 * Revoke ordering (deliberate divergence from kill's flip-before-relay,
 * recorded in HANDOFF): the relay SEND happens BEFORE the DB flip. Kill
 * flips first because its liquidation legs race the scheduler; here nothing
 * races, and relay-first means a failed send changes NOTHING (honest retry)
 * instead of stranding revoked DB rows over live onchain authority. If the
 * process dies between send and flip, the chain leads the DB — the worker's
 * next recordExecution reverts NotActive and receipts honestly (module 08
 * family-3 behavior); safe in both directions.
 */

/** Broker/guardian cards with live onchain authority — kill.ts's exact
 *  query (legacy NEVER touched; estate is doc 14's own card). */
async function onchainPlans(db: Db, userId: string) {
  return db
    .select({ id: plans.id, kind: plans.kind, contractPlanId: plans.contractPlanId })
    .from(plans)
    .where(
      and(
        eq(plans.userId, userId),
        ne(plans.kind, "legacy"),
        inArray(plans.status, ["active", "paused"]),
        sql`${plans.contractPlanId} is not null`,
      ),
    );
}

/** Short in-request confirmation poll — the relay send is fire-and-forget,
 *  but the page deserves a real answer when one arrives quickly. */
const CONFIRM_ATTEMPTS = 5;
const CONFIRM_INTERVAL_MS = 1_500;

export const securityRouter = router({
  /** C13 §3 — five rows of live delegation state. Fresh-only 30s cache;
   *  every failure is the honest "couldn't check just now". */
  delegations: gatedProcedure.query(async ({ ctx }): Promise<DelegationsResult> => {
    const { userId, eoaAddr } = ctx.session;
    const cached = delegationsCache.fresh(userId);
    if (cached) return cached;
    const result = await buildDelegations(eoaAddr);
    delegationsCache.set(userId, result);
    return result;
  }),

  /** The digest + authoritative nonce the owner personal_signs headlessly
   *  (kill.prepare's shape), plus what "all staff" currently means. */
  prepareRevokeAll: protectedProcedure.query(async ({ ctx }) => {
    const { userId, eoaAddr } = ctx.session;
    const live = await onchainPlans(ctx.db, userId);
    const needsRevoke = live.length > 0;
    let digest: string | null = null;
    let nonce: string | null = null;
    if (needsRevoke) {
      const relay = getPlanRelay();
      const n = await relay.authNonce(eoaAddr);
      digest = revokeAllDigest(relay.domain, { nonce: n });
      nonce = n.toString();
    }
    return {
      needsRevoke,
      digest,
      nonce,
      revocable: live.map((p) => ({ planId: p.id, kind: p.kind })),
    };
  }),

  /** One tap (+ the typed word, client-side): every agent loses authority in
   *  one onchain call; nothing is liquidated. */
  revokeAll: signedProcedure
    .input(withSig(securityRevokeAllPayloadSchema))
    .mutation(async ({ ctx, input }) => {
      const { userId, eoaAddr } = ctx.session;
      const auth = input.payload;
      const relay = getPlanRelay();

      const live = await onchainPlans(ctx.db, userId);
      if (live.length === 0) {
        return { state: "nothing" as const, dismissed: 0, txHash: null };
      }

      // Auth validation before ANY write (kill's ordering): a stale nonce
      // means the signed digest no longer matches the chain.
      const authNonce = await relay.authNonce(eoaAddr);
      if (BigInt(auth.nonce) !== authNonce) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "authorization expired — re-prepare and sign again",
        });
      }
      if (!relay.verifyRevokeAll(eoaAddr, BigInt(auth.nonce), auth.signature)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "signature does not match this account",
        });
      }

      // Relay FIRST (see the header): a failed send changes nothing.
      let txHash: string;
      try {
        ({ txHash } = await relay.revokeAll({
          owner: eoaAddr,
          nonce: BigInt(auth.nonce),
          ownerSig: auth.signature,
        }));
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "couldn't send the dismissal — nothing was changed. Try again.",
          cause: err,
        });
      }

      // DB flip + receipts, exactly-once under the users-row lock.
      await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`select id from users where id = ${userId} for update`);
        await tx
          .update(plans)
          .set({ status: "revoked" })
          .where(
            inArray(
              plans.id,
              live.map((p) => p.id),
            ),
          );
        await tx.insert(events).values(
          live.map((p) => ({
            userId,
            type: "plan.revoked",
            payloadJson: {
              planId: p.id,
              contractPlanId: p.contractPlanId,
              txHash,
              receipt: planDismissedReceipt(p.kind),
            },
          })),
        );
        await tx.insert(events).values({
          userId,
          type: SECURITY_EVENTS.revokeAll,
          payloadJson: { nonce: auth.nonce, txHash, planIds: live.map((p) => p.id) },
        });
      });

      // Short confirmation poll — answer with the truth we have.
      let state: "submitted" | "confirmed" | "failed" = "submitted";
      for (let i = 0; i < CONFIRM_ATTEMPTS; i++) {
        try {
          const status = await relay.txStatus(txHash);
          if (status === "confirmed") {
            state = "confirmed";
            break;
          }
          if (status === "failed") {
            state = "failed";
            break;
          }
        } catch {
          break; // stay "submitted" — revokeStatus can answer later
        }
        await new Promise((r) => setTimeout(r, CONFIRM_INTERVAL_MS));
      }

      return { state, dismissed: live.length, txHash };
    }),

  /** Lazy confirmation read for a submitted revoke-all. */
  revokeStatus: protectedProcedure.query(async ({ ctx }) => {
    const { userId } = ctx.session;
    const res = await ctx.db.execute(
      sql`select payload_json from events
          where user_id = ${userId} and type = ${SECURITY_EVENTS.revokeAll}
          order by created_at desc limit 1`,
    );
    const row = res.rows[0] as { payload_json: { txHash?: string } } | undefined;
    const txHash = row?.payload_json.txHash;
    if (!txHash) return { state: "none" as const, txHash: null };
    try {
      const state = await getPlanRelay().txStatus(txHash);
      return { state, txHash };
    } catch {
      return { state: "pending" as const, txHash };
    }
  }),
});
