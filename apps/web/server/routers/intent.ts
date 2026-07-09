import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../trpc";

export const intentRouter = router({
  // Returns PolicyDraft (module 09).
  parse: protectedProcedure.mutation(() => {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "intent.parse — module 09" });
  }),
});
