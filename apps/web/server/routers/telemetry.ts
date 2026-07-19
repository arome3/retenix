// PS-8.2 instrumentation writes (doc 17 §Observability).
//
// THE SECURITY PROPERTY THAT MATTERS: the event `type` is never client-supplied,
// and neither is `user_id`. The route maps a closed surface enum onto a
// server-side literal from UI_EVENTS and reads the user off the session.
//
// This is not stylistic. server/trpc.ts's assertGatePassed reads the SAME
// events table for compliance.quiz_passed and feeds its payload into
// isLeverageUnlocked — so a telemetry route that accepted a free-form
// (type, payload) would let any signed-in user write their own compliance row
// and unlock leverage. The enum, the .strict() schemas, and the server-side
// type literal are all load-bearing; there is a test asserting exactly this.

import { and, eq, sql } from "drizzle-orm";
import { events } from "@retenix/db";
import {
  UI_EVENTS,
  uiNetworkNamedInputSchema,
  uiSessionStartedInputSchema,
} from "@retenix/shared";

import { protectedProcedure, router } from "../trpc";
import { takeTelemetrySlot } from "../lib/telemetry-rate-limit";

/**
 * Every surface in scope lives under app/(app)/, whose layout already awaits
 * requireSession() before children mount, so a session always exists by the
 * time any of these fire. publicProcedure would buy an anonymous write path
 * into the events table for nothing.
 *
 * (Contrast auth.trackOnboarding, which IS public — onboarding.started
 * genuinely runs before a session exists.)
 */
export const telemetryRouter = router({
  /**
   * A surface put a source's proper name on screen. Named `sourceNamed` rather
   * than after the wire type: "sources" is the product word (G12), and the
   * spec-exact string stays in packages/shared where copy-canon cannot see it.
   */
  sourceNamed: protectedProcedure
    .input(uiNetworkNamedInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!takeTelemetrySlot(ctx.session.userId)) return { ok: false as const };

      // Bounds rows at |surfaces| + 1 per session however the client behaves.
      // This, not the rate limit, is what makes the metric trustworthy.
      const [seen] = await ctx.db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.type, UI_EVENTS.networkNamed),
            sql`${events.payloadJson}->>'sid' = ${input.sid}`,
            sql`${events.payloadJson}->>'surface' = ${input.surface}`,
          ),
        )
        .limit(1);
      if (seen) return { ok: true as const, deduped: true };

      await ctx.db.insert(events).values({
        userId: ctx.session.userId,
        type: UI_EVENTS.networkNamed,
        // No path, no address, no user agent: a session id and which surface.
        payloadJson: { sid: input.sid, surface: input.surface },
      });
      return { ok: true as const, deduped: false };
    }),

  /** The denominator (see UI_EVENTS.sessionStarted). One row per tab session. */
  sessionStarted: protectedProcedure
    .input(uiSessionStartedInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!takeTelemetrySlot(ctx.session.userId)) return { ok: false as const };

      const [seen] = await ctx.db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.type, UI_EVENTS.sessionStarted),
            sql`${events.payloadJson}->>'sid' = ${input.sid}`,
          ),
        )
        .limit(1);
      if (seen) return { ok: true as const, deduped: true };

      await ctx.db.insert(events).values({
        userId: ctx.session.userId,
        type: UI_EVENTS.sessionStarted,
        payloadJson: {
          sid: input.sid,
          // Joins this funnel to module 02's PS-F1-AC1 warm-path funnel.
          onboardingSid: input.onboardingSid ?? null,
        },
      });
      return { ok: true as const, deduped: false };
    }),
});
