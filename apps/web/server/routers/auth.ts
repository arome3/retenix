import { TRPCError } from "@trpc/server";
import { events, users } from "@retenix/db";
import { and, eq, sql } from "drizzle-orm";
import { getAddress } from "ethers";
import { z } from "zod";
import { devAffordances } from "@/env";
import { hashEmail } from "@/lib/emailHash";
import { getMagicAdmin } from "../magic-admin";
import { clearSessionCookie, setSessionCookie } from "../session";
import { protectedProcedure, publicProcedure, router } from "../trpc";

/*
 * DID tokens are the only client-to-server identity claim. A publicAddress sent
 * by the browser is never read, never trusted, and never persisted — the address
 * below comes out of Magic, keyed by MAGIC_SECRET_KEY.
 *
 * Every failure is the same 401 with the same message: a caller learns whether it
 * is signed in, and nothing about why a token was refused.
 */
const unauthorized = () =>
  new TRPCError({
    code: "UNAUTHORIZED",
    message: "we could not verify that sign-in",
  });

const REGION_UNSET = "";

export const authRouter = router({
  magicCallback: publicProcedure
    .input(z.object({ didToken: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const mAdmin = await getMagicAdmin();

      let issuer: string;
      let email: string | null;
      let publicAddress: string | null;
      try {
        mAdmin.token.validate(input.didToken); // throws on forgery or expiry
        const meta = await mAdmin.users.getMetadataByToken(input.didToken);

        // Metadata is fetched by token, but bind it to the token's own issuer
        // anyway: what we store must be what the signature covers.
        issuer = mAdmin.token.getIssuer(input.didToken);
        if (!meta.issuer || meta.issuer !== issuer) throw unauthorized();

        email = meta.email;
        publicAddress = meta.publicAddress;
      } catch {
        throw unauthorized();
      }
      if (!email || !publicAddress) throw unauthorized();

      let eoaAddr: string;
      try {
        eoaAddr = getAddress(publicAddress); // one canonical casing per address
      } catch {
        throw unauthorized();
      }

      // ua_evm_addr / ua_sol_addr are filled by doc 03 on first UA init; region
      // stays unset until the eligibility gate (doc 04) — the gate is enforced by
      // its absence. Those columns are notNull in doc 00's canonical schema, so
      // "" is the sentinel for "not yet set".
      const [row] = await ctx.db
        .insert(users)
        .values({
          emailHash: hashEmail(email),
          eoaAddr,
          uaEvmAddr: "",
          uaSolAddr: "",
          region: REGION_UNSET,
        })
        .onConflictDoUpdate({ target: users.emailHash, set: { eoaAddr } })
        .returning({ id: users.id, region: users.region });

      await setSessionCookie(ctx, {
        userId: row.id,
        eoa: eoaAddr,
        issuer,
        region: row.region,
      });

      // Server-derived, so the client never has to trust its own copy.
      return { eoa: eoaAddr, region: row.region };
    }),

  // Clearing an httpOnly cookie needs the server. The client pairs this with
  // magic.user.logout() to end the Magic session too.
  logout: publicProcedure.mutation(({ ctx }) => {
    clearSessionCookie(ctx);
    return { ok: true };
  }),

  /*
   * PROPOSED (beyond tech spec §13): warm-path instrumentation for PS-F1-AC1.
   * Both rows carry the server clock and are joined by a client-minted sid, so
   * the measured duration never depends on a browser's idea of the time.
   * "started" runs before a session exists, hence public.
   */
  trackOnboarding: publicProcedure
    .input(z.object({ step: z.enum(["started", "ready"]), sid: z.uuid() }))
    .mutation(async ({ input, ctx }) => {
      const type = `onboarding.${input.step}`;

      // Idempotent: a remount or a StrictMode double-effect must not double-write.
      const [existing] = await ctx.db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.type, type),
            sql`${events.payloadJson}->>'sid' = ${input.sid}`,
          ),
        )
        .limit(1);
      if (existing) return { ok: true, elapsedMs: null };

      if (input.step === "started") {
        await ctx.db
          .insert(events)
          .values({ userId: null, type, payloadJson: { sid: input.sid } });
        return { ok: true, elapsedMs: null };
      }

      if (!ctx.session) throw unauthorized();

      const [started] = await ctx.db
        .select({ createdAt: events.createdAt })
        .from(events)
        .where(
          and(
            eq(events.type, "onboarding.started"),
            sql`${events.payloadJson}->>'sid' = ${input.sid}`,
          ),
        )
        .limit(1);

      const elapsedMs = started
        ? Date.now() - started.createdAt.getTime()
        : null;
      await ctx.db.insert(events).values({
        userId: ctx.session.userId,
        type,
        payloadJson: { sid: input.sid, elapsedMs },
      });
      return { ok: true, elapsedMs };
    }),

  /*
   * TODO(doc 04): delete this, and the Continue button that calls it, once the
   * eligibility gate lands — doc 04 owns the region model. It exists only so S1
   * is walkable end to end before then, and it cannot run in a production build.
   */
  devSetRegion: protectedProcedure
    .input(z.object({ region: z.string().regex(/^[A-Z]{2}$/) }))
    .mutation(async ({ input, ctx }) => {
      if (!devAffordances) {
        throw new TRPCError({ code: "FORBIDDEN", message: "not available" });
      }
      await ctx.db
        .update(users)
        .set({ region: input.region })
        .where(eq(users.id, ctx.session.userId));

      await setSessionCookie(ctx, {
        userId: ctx.session.userId,
        eoa: ctx.session.eoaAddr,
        issuer: ctx.session.issuer,
        region: input.region,
      });
      return { region: input.region };
    }),
});
