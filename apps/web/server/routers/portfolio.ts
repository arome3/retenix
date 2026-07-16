import { users } from "@retenix/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import {
  computeHoldings,
  defaultHoldingsDeps,
  holdingsCache,
  type HoldingsResponse,
} from "../lib/holdings";
import { gatedProcedure, router } from "../trpc";

export const portfolioRouter = router({
  // The brokerage statement (doc 12, TS-13.1). Composes off gatedProcedure —
  // NOT §13's literal protectedProcedure — per the binding modules-04/06/09/
  // 10/11 convention: holdings are asset data, and gated ⊃ protected.
  //
  // Contract (doc 12 verbatim) + documented extensions: costBasisUsd/deltaUsd/
  // deltaPct are null when basis is unknowable ("—", return omitted — never
  // guessed), markStale drives the doc-01 stale marker, asOf keys the cache,
  // qtyHuman survives to sell-all, unattributedBuys feeds the dev banner.
  //
  // Failure honesty (account.summary precedent): serve the last-known
  // statement with its OLD asOf when sources are down; with no last-known,
  // an honest error — never a fabricated number, never a spinner over money.
  holdings: gatedProcedure.query(
    async ({ ctx }): Promise<HoldingsResponse> => {
      const { userId } = ctx.session;

      const fresh = holdingsCache.fresh(userId);
      if (fresh) return fresh;

      try {
        const [row] = await ctx.db
          .select({ uaSolAddr: users.uaSolAddr })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        const response = await computeHoldings(ctx.db, defaultHoldingsDeps(), {
          userId,
          uaSolAddr: row?.uaSolAddr ?? "",
        });
        holdingsCache.set(userId, response);
        return response;
      } catch {
        const stale = holdingsCache.stale(userId);
        if (stale) return stale;
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: "portfolio sources unavailable",
        });
      }
    },
  ),
});
