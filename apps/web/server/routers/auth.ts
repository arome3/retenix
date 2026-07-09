import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "../trpc";

export const authRouter = router({
  magicCallback: publicProcedure.mutation(() => {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "auth.magicCallback — module 02" });
  }),
});
