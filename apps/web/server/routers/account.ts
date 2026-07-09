import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../trpc";

export const accountRouter = router({
  // Buying power + breakdown (module 06).
  summary: protectedProcedure.query(() => {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "account.summary — module 06" });
  }),
});
