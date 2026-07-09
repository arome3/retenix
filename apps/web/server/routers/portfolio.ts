import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../trpc";

export const portfolioRouter = router({
  holdings: protectedProcedure.query(() => {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "portfolio.holdings — module 12" });
  }),
});
