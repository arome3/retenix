import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../trpc";

export const activityRouter = router({
  feed: protectedProcedure.query(() => {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "activity.feed — module 11" });
  }),
});
