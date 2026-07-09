import { TRPCError } from "@trpc/server";
import { withSig } from "@retenix/shared";
import { z } from "zod";
import { claimGatedProcedure, router, signedProcedure } from "../trpc";

export const estateRouter = router({
  enroll: signedProcedure.input(withSig(z.unknown())).mutation(() => {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "estate.enroll — module 14" });
  }),
  checkIn: signedProcedure.input(withSig(z.unknown())).mutation(() => {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "estate.checkIn — module 14" });
  }),
  // Heir; token-gated email link (module 14).
  claimStart: claimGatedProcedure
    .input(z.object({ token: z.string().min(1) }))
    .mutation(() => {
      throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "estate.claimStart — module 14" });
    }),
});
