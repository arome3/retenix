import { users } from "@retenix/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc";

// A base58 Solana address: 32 bytes → 32–44 base58 chars (alphabet excludes 0 O I l).
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const accountRouter = router({
  // Buying power + breakdown (module 06).
  summary: protectedProcedure.query(() => {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "account.summary — module 06" });
  }),

  // PROPOSED (spec-silent) — doc 03 task 7: first-login persistence of the UA
  // addresses. Client-initiated post-login (lib/post-login.ts): the client derives
  // the addresses with @retenix/ua getAddresses and calls this. The server does NOT
  // trust the client blindly —
  //   • uaEvm MUST equal the session EOA (in 7702 mode the EVM UA ≙ the EOA), and the
  //     server persists the session EOA, never the client-supplied value. A mismatch
  //     is a real anomaly (wrong session / SDK change) and hard-fails.
  //   • uaSol is a distinct address only Particle derives (SOLANA_ACCOUNT_INDEX.EIP7702
  //     = 11); it is structurally validated and stored (a wrong value only misdirects
  //     the user's OWN SPL deposit target — self-harm-only blast radius).
  // Idempotent: only the first login (empty ua_evm_addr, written "" by doc 02) writes.
  bootstrap: protectedProcedure
    .input(z.object({ uaEvm: z.string(), uaSol: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const eoa = ctx.session.eoaAddr;
      if (input.uaEvm.toLowerCase() !== eoa.toLowerCase()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "uaEvm must equal the session EOA (7702: the EVM UA is the EOA)",
        });
      }
      if (!SOLANA_ADDRESS.test(input.uaSol)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "uaSol is not a valid Solana address",
        });
      }

      const [existing] = await ctx.db
        .select({ uaEvmAddr: users.uaEvmAddr, uaSolAddr: users.uaSolAddr })
        .from(users)
        .where(eq(users.id, ctx.session.userId))
        .limit(1);

      // Already bootstrapped — idempotent no-op (concurrent double-fire converges:
      // both writes set the same derived values).
      if (existing?.uaEvmAddr) {
        return {
          bootstrapped: false,
          uaEvm: existing.uaEvmAddr,
          uaSol: existing.uaSolAddr,
        };
      }

      await ctx.db
        .update(users)
        .set({ uaEvmAddr: eoa, uaSolAddr: input.uaSol })
        .where(eq(users.id, ctx.session.userId));

      return { bootstrapped: true, uaEvm: eoa, uaSol: input.uaSol };
    }),
});
