// estate.* (doc 14) — enrollment (S5), the heartbeat check-in (C8's "I'm
// here"), estate status (C8/S5 polling), and the heir claim gate (S6).
//
// Trust boundaries, restated where they bind:
// - enroll/checkIn are signedProcedure: the owner's personal_sign envelope IS
//   the provenance the relayer requires (CONFLICTS #13); the proof is stored
//   on the events row.
// - the web ENCRYPTS estate secrets and never decrypts them; the keccak
//   (email‖salt) revealed-match runs keeper-side. claimStart's email check
//   compares sha256 hashes (users.email_hash format) — the heir must hold a
//   Magic session ON the beneficiary email (the owner's chosen trust anchor).
// - one relayed checkIn both bumps lastCheckIn and cancels a live countdown
//   (the contract's veto-by-liveness) — the PS-F7-AC2 moment is one tap.
import { TRPCError } from "@trpc/server";
import {
  ESTATE_CHAIN_IDS,
  ESTATE_EVENTS,
  beneficiaryHashFor,
  claimChainProgressSchema,
  estateCheckInPayloadSchema,
  estateClaimedReceipt,
  estateCheckinButtonReceipt,
  estateEnrolledReceipt,
  estateEnrollPayloadSchema,
  estateRefreshPayloadSchema,
  maskEmail,
  resolveInactivitySecs,
  withSig,
  type ClaimChainProgress,
  type EstateStatusView,
  type EstateSummary,
} from "@retenix/shared";
import { estates, events, plans, users } from "@retenix/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/env";
import { hashEmail } from "@/lib/emailHash";
import {
  claimDelegateFor,
  encryptBeneficiarySecret,
  encryptTupleSet,
  getEscrowProvider,
  getEstateChainReader,
  findClaimToken,
  readEstateView,
} from "../lib/estate";
import { getPlanRelay } from "../lib/relay-factory";
import { claimGatedProcedure, protectedProcedure, router, signedProcedure } from "../trpc";

const DEMO = env.DEMO_MODE === "1";

/** The S5 wizard's server-read inputs: per-chain ceremony targets (delegate +
 *  live account nonce), the relay domain + authNonce for the digest, demo
 *  scaling, and any legacy-card prefill (module 10 stashed the draft). */
export interface PrepareEnroll {
  targets: { chainId: number; delegateAddress: string; nonce: number }[];
  domain: { chainId: number; contract: string };
  authNonce: string;
  demoMode: boolean;
  demoInactivitySecs: number;
  prefill: { beneficiaryEmail: string | null; inactivityDays: number | null } | null;
}

function calmRelayError(op: string, err: unknown): TRPCError {
  const message = err instanceof Error ? err.message : String(err);
  return new TRPCError({
    code: "CONFLICT",
    message: `couldn't complete ${op} — nothing was changed. ${message}`,
  });
}

export const estateRouter = router({
  // -------------------------------------------------------------------------
  // prepareEnroll (PROPOSED helper query — the plans.prepareActivation
  // precedent): everything the browser ceremony needs in one round trip.
  // -------------------------------------------------------------------------
  prepareEnroll: protectedProcedure.query(async ({ ctx }): Promise<PrepareEnroll> => {
    const owner = ctx.session.eoaAddr;
    const relay = getPlanRelay();
    const reader = getEstateChainReader();
    const [authNonce, ...nonces] = await Promise.all([
      relay.authNonce(owner),
      ...ESTATE_CHAIN_IDS.map((chainId) => reader.accountNonce(chainId, owner)),
    ]);

    // module 10 deviation 9: a legacy draft/active card pre-fills the wizard
    const legacyRows = await ctx.db
      .select({ params: plans.paramsJson })
      .from(plans)
      .where(
        and(
          eq(plans.userId, ctx.session.userId),
          eq(plans.kind, "legacy"),
          inArray(plans.status, ["draft", "active"]),
        ),
      )
      .limit(1);
    const legacyParams = legacyRows[0]?.params as
      | { beneficiaryEmail?: string; inactivityDays?: number }
      | null
      | undefined;
    const prefillEmail =
      typeof legacyParams?.beneficiaryEmail === "string" &&
      legacyParams.beneficiaryEmail.includes("@") &&
      !legacyParams.beneficiaryEmail.includes("•")
        ? legacyParams.beneficiaryEmail
        : null;

    return {
      targets: ESTATE_CHAIN_IDS.map((chainId, i) => ({
        chainId,
        delegateAddress: claimDelegateFor(chainId),
        nonce: nonces[i]!,
      })),
      domain: relay.domain,
      authNonce: String(authNonce),
      demoMode: DEMO,
      demoInactivitySecs: env.DEMO_INACTIVITY_SECS,
      prefill: legacyParams
        ? {
            beneficiaryEmail: prefillEmail,
            inactivityDays:
              typeof legacyParams.inactivityDays === "number"
                ? legacyParams.inactivityDays
                : null,
          }
        : null,
    };
  }),

  // -------------------------------------------------------------------------
  // enroll — the signed S5 mutation. Relay first (the chain is the authority;
  // a relay failure leaves NOTHING enrolled), then encrypt + persist + scrub.
  // -------------------------------------------------------------------------
  enroll: signedProcedure
    .input(withSig(estateEnrollPayloadSchema))
    .mutation(async ({ ctx, input }) => {
      const payload = estateEnrollPayloadSchema.parse(input.payload);
      const owner = ctx.session.eoaAddr;

      // every tuple must point at the recorded delegate for its chain — a
      // tuple aimed anywhere else is never escrowed (TS-14.3 surface bound)
      for (const t of payload.tuples) {
        const expected = claimDelegateFor(t.chainId);
        if (t.address.toLowerCase() !== expected.toLowerCase()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `authorization for source ${t.chainId} does not match the recorded coverage`,
          });
        }
      }

      const { inactivitySecs, demoScaled } = resolveInactivitySecs(
        payload.inactivityDays,
        DEMO,
        env.DEMO_INACTIVITY_SECS,
      );
      const beneficiaryHash = beneficiaryHashFor(payload.beneficiaryEmail, payload.salt);

      const relay = getPlanRelay();
      let txHash: string;
      try {
        ({ txHash } = await relay.enrollEstate({
          owner,
          beneficiaryHash,
          inactivitySecs: BigInt(inactivitySecs),
          nonce: BigInt(payload.auth.nonce),
          ownerSig: payload.auth.signature,
        }));
      } catch (err) {
        throw calmRelayError("enrollment", err);
      }

      const provider = getEscrowProvider();
      const [emailEnc, tuplesEnc] = await Promise.all([
        encryptBeneficiarySecret(provider, owner, {
          email: payload.beneficiaryEmail,
          salt: payload.salt,
          ownerName: payload.ownerDisplayName,
        }),
        encryptTupleSet(provider, owner, payload.tuples),
      ]);

      const nowIso = new Date().toISOString();
      const cache = {
        status: "enrolled",
        lastCheckIn: nowIso,
        deadlineAt: new Date(Date.now() + inactivitySecs * 1000).toISOString(),
        claimReadyAt: null,
        inactivitySecs,
        demoScaled,
        updatedAt: nowIso,
        lastObservedTxAt: null,
      };
      await ctx.db
        .insert(estates)
        .values({
          userId: ctx.session.userId,
          beneficiaryEmailEnc: emailEnc,
          tuplesEnc,
          refreshedAt: new Date(),
          contractStateCache: cache,
        })
        .onConflictDoUpdate({
          target: estates.userId,
          set: {
            beneficiaryEmailEnc: emailEnc,
            tuplesEnc,
            refreshedAt: new Date(),
            contractStateCache: cache,
          },
        });

      // doc 14 "never": beneficiary email in plaintext at rest — rewrite the
      // module-10 legacy card params to the display mask now that the real
      // address lives in the KMS envelope.
      const legacyRows = await ctx.db
        .select({ id: plans.id, params: plans.paramsJson })
        .from(plans)
        .where(and(eq(plans.userId, ctx.session.userId), eq(plans.kind, "legacy")));
      for (const row of legacyRows) {
        const params = row.params as Record<string, unknown> | null;
        if (params && typeof params.beneficiaryEmail === "string" && params.beneficiaryEmail.includes("@")) {
          await ctx.db
            .update(plans)
            .set({
              paramsJson: {
                ...params,
                beneficiaryEmail: maskEmail(params.beneficiaryEmail),
                enrollEstateAuth: null,
              },
            })
            .where(eq(plans.id, row.id));
        }
      }

      await ctx.db.insert(events).values({
        userId: ctx.session.userId,
        type: ESTATE_EVENTS.enrolled,
        payloadJson: {
          receipt: estateEnrolledReceipt(),
          txHash,
          inactivitySecs,
          demoScaled,
          // sha256(lowercase(email)) — users.email_hash format; claimStart's
          // session-email check reads the keeper's copy, this one is audit
          beneficiaryEmailHash: hashEmail(payload.beneficiaryEmail),
        },
      });

      const view = await readEstateView(getPlanRelay(), ctx.db, ctx.session.userId, owner);
      return { txHash, view };
    }),

  // -------------------------------------------------------------------------
  // refreshTuples — the silent login/post-transaction ceremony (stale tuples
  // are the dead-man switch working; a fresh set is strictly-newer coverage).
  // Protected, not signed: tuples only ever delegate to the audited
  // RetenixClaim and are useless before Claimable.
  // -------------------------------------------------------------------------
  refreshTuples: protectedProcedure
    .input(estateRefreshPayloadSchema)
    .mutation(async ({ ctx, input }) => {
      const owner = ctx.session.eoaAddr;
      for (const t of input.tuples) {
        const expected = claimDelegateFor(t.chainId);
        if (t.address.toLowerCase() !== expected.toLowerCase()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `authorization for source ${t.chainId} does not match the recorded coverage`,
          });
        }
      }
      const [row] = await ctx.db
        .select({ userId: estates.userId })
        .from(estates)
        .where(eq(estates.userId, ctx.session.userId))
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "no inheritance plan to refresh" });
      }
      const tuplesEnc = await encryptTupleSet(getEscrowProvider(), owner, input.tuples);
      await ctx.db
        .update(estates)
        .set({ tuplesEnc, refreshedAt: new Date() })
        .where(eq(estates.userId, ctx.session.userId));
      return { refreshedAt: new Date().toISOString() };
    }),

  // -------------------------------------------------------------------------
  // checkIn — "I'm here". One signed tap; the relayed call bumps lastCheckIn
  // and, mid-countdown, returns the estate to Enrolled (PS-F7-AC2).
  // -------------------------------------------------------------------------
  checkIn: signedProcedure
    .input(withSig(estateCheckInPayloadSchema))
    .mutation(async ({ ctx, input }) => {
      estateCheckInPayloadSchema.parse(input.payload);
      const owner = ctx.session.eoaAddr;
      const relay = getPlanRelay();

      let cancelledCountdown = false;
      try {
        const before = await relay.estateOf(owner);
        // stored Countdown (status 2) or virtually Claimable (3) — the same
        // relayed call is the cancel
        cancelledCountdown = before.status === 2 || before.status === 3;
      } catch {
        // the relay call below is the authority; the flag only shapes copy
      }

      let txHash: string;
      try {
        ({ txHash } = await relay.checkIn(owner));
      } catch (err) {
        throw calmRelayError("the check-in", err);
      }

      const envelope = (input as { sig?: unknown }).sig ?? null;
      await ctx.db.insert(events).values({
        userId: ctx.session.userId,
        type: ESTATE_EVENTS.checkin,
        payloadJson: {
          receipt: estateCheckinButtonReceipt(cancelledCountdown),
          source: "im-here",
          cancelledCountdown,
          txHash,
          // CONFLICTS #13 — the provenance proof the relayer required
          proof: envelope,
        },
      });

      const view = await readEstateView(relay, ctx.db, ctx.session.userId, owner);
      return { cancelledCountdown, txHash, view };
    }),

  // -------------------------------------------------------------------------
  // status — C8 + S5 poll this (chain first, cache fallback).
  // -------------------------------------------------------------------------
  status: protectedProcedure.query(
    async ({ ctx }): Promise<{ enrolled: boolean; view: EstateStatusView | null }> => {
      const view = await readEstateView(
        getPlanRelay(),
        ctx.db,
        ctx.session.userId,
        ctx.session.eoaAddr,
      );
      return { enrolled: view !== null, view };
    },
  ),

  // -------------------------------------------------------------------------
  // claimInfo — S6's first read, pre-onboarding: who named the heir, the
  // estate summary, and whether the link is still good. Token-shape gated.
  // -------------------------------------------------------------------------
  claimInfo: claimGatedProcedure
    .input(z.object({ token: z.string().min(1) }))
    .query(
      async ({ ctx, input }): Promise<{
        state: "ready" | "used" | "expired";
        ownerName: string | null;
        summary: EstateSummary | null;
      }> => {
        const record = await findClaimToken(ctx.db, input.token);
        if (!record) {
          throw new TRPCError({ code: "NOT_FOUND", message: "This link isn't valid." });
        }
        const state = record.used
          ? "used"
          : record.expiresAt.getTime() < Date.now()
            ? "expired"
            : "ready";
        return { state, ownerName: record.ownerName, summary: record.summary };
      },
    ),

  // -------------------------------------------------------------------------
  // claimStart — the heir's one button. Requires the token AND a Magic
  // session on the beneficiary email (the owner's chosen trust anchor —
  // doc 14's email-compromise bound). Single-use under the owner-row lock.
  // -------------------------------------------------------------------------
  claimStart: claimGatedProcedure
    .input(z.object({ token: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.session) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "confirm your email first",
        });
      }
      const heirUserId = ctx.session.userId;
      const heirEoa = ctx.session.eoaAddr;

      const record = await findClaimToken(ctx.db, input.token);
      if (!record) {
        throw new TRPCError({ code: "NOT_FOUND", message: "This link isn't valid." });
      }
      if (record.expiresAt.getTime() < Date.now()) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This link has expired." });
      }

      // the session email must BE the beneficiary email (sha256 comparison —
      // the web never decrypts; the keeper re-verifies keccak(email‖salt)
      // against the onchain commitment before moving anything)
      if (record.beneficiaryEmailHash) {
        const [heirRow] = await ctx.db
          .select({ emailHash: users.emailHash })
          .from(users)
          .where(eq(users.id, heirUserId))
          .limit(1);
        if (!heirRow || heirRow.emailHash !== record.beneficiaryEmailHash) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "This claim belongs to a different email address.",
          });
        }
      }

      // single-use under the OWNER-row lock (the consumeNonce idiom)
      await ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from users where id = ${record.ownerUserId} for update`,
        );
        const usedRows = await tx
          .select({ payload: events.payloadJson })
          .from(events)
          .where(
            and(
              eq(events.userId, record.ownerUserId),
              eq(events.type, ESTATE_EVENTS.claimStarted),
            ),
          )
          .limit(50);
        const alreadyUsed = usedRows.some(
          (r) => (r.payload as { tokenHash?: string } | null)?.tokenHash === record.tokenHash,
        );
        if (alreadyUsed) {
          throw new TRPCError({ code: "CONFLICT", message: "This claim has already started." });
        }
        await tx.insert(events).values([
          {
            userId: record.ownerUserId,
            type: ESTATE_EVENTS.claimStarted,
            payloadJson: { tokenHash: record.tokenHash, heirUserId, heirEoa },
          },
          {
            // the keeper's work order — it takes over from here (DB-mediated;
            // no web→worker call path exists by design)
            userId: record.ownerUserId,
            type: ESTATE_EVENTS.claimRequested,
            payloadJson: { tokenHash: record.tokenHash, heirUserId, heirEoa },
          },
        ]);
      });

      return { ok: true, ownerName: record.ownerName, summary: record.summary };
    }),

  // -------------------------------------------------------------------------
  // claimStatus — S6 polls the keeper's per-chain progress. The token is the
  // read capability (the heir holds it; nothing else identifies them yet).
  // -------------------------------------------------------------------------
  claimStatus: claimGatedProcedure
    .input(z.object({ token: z.string().min(1) }))
    .query(
      async ({ ctx, input }): Promise<{
        started: boolean;
        done: boolean;
        receipt: string | null;
        sources: ClaimChainProgress[];
      }> => {
        const record = await findClaimToken(ctx.db, input.token);
        if (!record) {
          throw new TRPCError({ code: "NOT_FOUND", message: "This link isn't valid." });
        }
        const rows = await ctx.db
          .select({ type: events.type, payload: events.payloadJson, at: events.createdAt })
          .from(events)
          .where(
            and(
              eq(events.userId, record.ownerUserId),
              inArray(events.type, [
                ESTATE_EVENTS.claimRequested,
                ESTATE_EVENTS.claimProgress,
                ESTATE_EVENTS.claimed,
              ]),
            ),
          )
          .orderBy(desc(events.createdAt))
          .limit(100);

        const started = rows.some((r) => r.type === ESTATE_EVENTS.claimRequested);
        const claimedRow = rows.find((r) => r.type === ESTATE_EVENTS.claimed);
        // newest progress row per chain wins
        const byChain = new Map<number, ClaimChainProgress>();
        for (const r of rows) {
          if (r.type !== ESTATE_EVENTS.claimProgress) continue;
          const parsed = claimChainProgressSchema.safeParse(r.payload);
          if (parsed.success && !byChain.has(parsed.data.chainId)) {
            byChain.set(parsed.data.chainId, parsed.data);
          }
        }
        const claimedPayload = claimedRow?.payload as { sourceCount?: number } | undefined;
        return {
          started,
          done: Boolean(claimedRow),
          receipt: claimedRow ? estateClaimedReceipt(claimedPayload?.sourceCount ?? 0) : null,
          sources: [...byChain.values()].sort((a, b) => a.chainId - b.chainId),
        };
      },
    ),
});
