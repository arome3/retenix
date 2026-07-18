import { events, users, type Db } from "@retenix/db";
import {
  COMPLIANCE_EVENTS,
  isEquityEligible,
  isLeverageUnlocked,
  isQuizAllCorrect,
  quizAnswersSchema,
  regionSchema,
} from "@retenix/shared";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { setSessionCookie } from "../session";
import { protectedProcedure, router } from "../trpc";

/*
 * The compliance gate (doc 04, component C12).
 *
 * TWO-PHASE REGION MODEL — load-bearing invariant:
 *   • setRegion records the pick as an immutable `compliance.region_set` event.
 *     It does NOT write users.region and does NOT flip the gate cookie.
 *   • acknowledgeRisk (the finalization) writes users.region atomically, ONLY
 *     after asserting the region/quiz/identity events all exist.
 * Therefore `users.region !== ""` is provably equivalent to the spec's
 * gatePassed = region && quizPassed && riskAck — the whole codebase's existing
 * "region ⟺ gate complete" signal (proxy.ts, require-session.ts, the gate
 * cookie, login) stays correct with zero changes. The region column is written
 * in exactly ONE place: acknowledgeRisk. Do not add another.
 *
 * Every step is idempotent and re-submittable: re-posting a completed step is a
 * no-op success, so an events-table hiccup mid-gate never strands a session
 * half-gated WITH access (access needs the region column, set only at the end).
 * setRegion and acknowledgeRisk lock the user row FOR UPDATE (the consumeNonce
 * idiom in trpc.ts) to serialize concurrent attempts.
 */

// The transaction handle drizzle hands the callback (a PgTransaction), distinct
// from the top-level Db — derived so the helpers below typecheck against it.
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** True iff an event of `type` already exists for the user. */
async function hasEvent(
  tx: Tx,
  userId: string,
  type: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.type, type)))
    .limit(1);
  return Boolean(row);
}

/**
 * The answers on the NEWEST quiz_passed event, or null if none.
 *
 * Newest, not earliest (unlike readRegionSet): the quiz gained a question in
 * doc 18 F11, so a user may hold a stale 3-answer row plus a fresh 4-answer
 * one. Region is set-once and immutable; quiz answers are upgradeable.
 */
async function readQuizAnswers(tx: Tx, userId: string): Promise<unknown> {
  const [row] = await tx
    .select({ payloadJson: events.payloadJson })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.type, COMPLIANCE_EVENTS.quizPassed),
      ),
    )
    .orderBy(desc(events.createdAt))
    .limit(1);
  return (row?.payloadJson as { answers?: unknown } | undefined)?.answers ?? null;
}

/** The region recorded by the earliest region_set event, or null if none. */
async function readRegionSet(tx: Tx, userId: string): Promise<string | null> {
  const [row] = await tx
    .select({ payloadJson: events.payloadJson })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.type, COMPLIANCE_EVENTS.regionSet),
      ),
    )
    .orderBy(asc(events.createdAt))
    .limit(1);
  return row ? (row.payloadJson as { region: string }).region : null;
}

/** Serialize per user, matching trpc.ts#consumeNonce. */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select id from users where id = ${userId} for update`);
}

export const complianceRouter = router({
  /*
   * Step 1 — country selection. Records the pick immutably; the column write is
   * deferred to acknowledgeRisk. Region is set exactly once: a second, DIFFERENT
   * region is rejected (prevents gate-shopping — e.g. picking US, seeing the
   * block, then re-picking DE to reach the equity path). Re-submitting the SAME
   * region is an idempotent no-op.
   */
  setRegion: protectedProcedure
    .input(z.object({ region: regionSchema }))
    .mutation(async ({ input, ctx }) => {
      const { region } = input;
      const userId = ctx.session.userId;

      await ctx.db.transaction(async (tx) => {
        await lockUser(tx, userId);

        // Immutability source of truth is both states: a finalized column
        // (post-gate / seeded) and a mid-gate region_set event.
        const [row] = await tx
          .select({ region: users.region })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        const current = (row?.region || "") || (await readRegionSet(tx, userId));

        if (current) {
          if (current !== region) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "region is already set",
            });
          }
          return; // same region re-submitted — idempotent
        }

        await tx.insert(events).values({
          userId,
          type: COMPLIANCE_EVENTS.regionSet,
          payloadJson: { region },
        });
      });

      // The client shows the hard-block screen for a restricted pick and then
      // continues into the same (crypto-basket) flow — no dead end.
      return { region, equityEligible: isEquityEligible(region) };
    }),

  /*
   * Step 2 — appropriateness quiz. Answers are re-validated server-side against
   * the shared key (never trust the client's "I passed"). Requires a region pick
   * first. Idempotent.
   */
  submitQuiz: protectedProcedure
    .input(z.object({ answers: quizAnswersSchema }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.session.userId;

      if (!isQuizAllCorrect(input.answers)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "quiz answers are not all correct",
        });
      }

      await ctx.db.transaction(async (tx) => {
        await lockUser(tx, userId);
        if ((await readRegionSet(tx, userId)) === null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "choose a region first",
          });
        }
        // Idempotent for a user whose stored answers already cover the CURRENT
        // quiz. Deliberately NOT `hasEvent(quizPassed)`: doc 18 F11 added a
        // fourth question, and a bare existence check would permanently strand
        // every pre-F11 user on 3 stale answers with no way to re-answer and
        // unlock leveraged assets. Re-submitting appends a newer row;
        // readQuizAnswers reads the newest.
        if (isLeverageUnlocked(await readQuizAnswers(tx, userId))) return;
        await tx.insert(events).values({
          userId,
          type: COMPLIANCE_EVENTS.quizPassed,
          payloadJson: { answers: input.answers },
        });
      });

      return { ok: true };
    }),

  /*
   * Step 3 — simulated identity (PS-10.4). The step is labeled simulated in the
   * UI and is NOT KYC: the entered name/DOB are validated for shape but never
   * persisted (PII minimization — the repo hashes even emails). Only the fact
   * that the step ran lands in the audit trail. Idempotent.
   */
  submitIdentity: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
        dob: z.string().trim().min(1).max(40),
      }),
    )
    .mutation(async ({ ctx }) => {
      const userId = ctx.session.userId;
      await ctx.db.transaction(async (tx) => {
        await lockUser(tx, userId);
        if (await hasEvent(tx, userId, COMPLIANCE_EVENTS.identitySimulated)) {
          return;
        }
        await tx.insert(events).values({
          userId,
          type: COMPLIANCE_EVENTS.identitySimulated,
          payloadJson: { simulated: true },
        });
      });
      return { ok: true };
    }),

  /*
   * Step 4 — risk acknowledgment AND gate finalization. In one transaction:
   * assert the prior gate events exist (this is what makes an out-of-order
   * deep-link un-finalizable), write the ack event, then write users.region via
   * a set-once CAS. Only here does the region column become non-empty. After the
   * txn, re-mint the session so the gate cookie flips and proxy/require-session
   * observe the completed gate. Idempotent (a re-run just re-mints the cookie).
   */
  acknowledgeRisk: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.session.userId;
    let region = "";

    await ctx.db.transaction(async (tx) => {
      await lockUser(tx, userId);

      const regionSet = await readRegionSet(tx, userId);
      if (regionSet === null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "choose a region first",
        });
      }
      if (!(await hasEvent(tx, userId, COMPLIANCE_EVENTS.quizPassed))) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "complete the quiz first",
        });
      }
      if (!(await hasEvent(tx, userId, COMPLIANCE_EVENTS.identitySimulated))) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "complete the identity step first",
        });
      }
      region = regionSet;

      if (!(await hasEvent(tx, userId, COMPLIANCE_EVENTS.riskAcknowledged))) {
        await tx.insert(events).values({
          userId,
          type: COMPLIANCE_EVENTS.riskAcknowledged,
          payloadJson: {},
        });
      }

      // Set-once: the column moves off "" only when the whole gate is complete.
      await tx
        .update(users)
        .set({ region })
        .where(and(eq(users.id, userId), eq(users.region, "")));
    });

    await setSessionCookie(ctx, {
      userId,
      eoa: ctx.session.eoaAddr,
      issuer: ctx.session.issuer,
      region,
    });

    return { ok: true, region };
  }),
});
