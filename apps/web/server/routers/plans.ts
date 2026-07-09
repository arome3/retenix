import { TRPCError } from "@trpc/server";
import { withSig } from "@retenix/shared";
import { z } from "zod";
import { router, signedProcedure } from "../trpc";

export const plansRouter = router({
  // Verifies signature, writes contract (module 10).
  activate: signedProcedure.input(withSig(z.unknown())).mutation(() => {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "plans.activate — module 10" });
  }),
  revoke: signedProcedure.input(withSig(z.unknown())).mutation(() => {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "plans.revoke — module 10" });
  }),
});
