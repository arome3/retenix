import { TRPCError } from "@trpc/server";
import { withSig } from "@retenix/shared";
import { z } from "zod";
import { protectedProcedure, router, signedProcedure } from "../trpc";

export const sweepRouter = router({
  preview: protectedProcedure.query(() => {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "sweep.preview — module 06" });
  }),
  execute: signedProcedure.input(withSig(z.unknown())).mutation(() => {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "sweep.execute — module 06" });
  }),
});
