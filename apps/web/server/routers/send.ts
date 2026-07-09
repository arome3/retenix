import { TRPCError } from "@trpc/server";
import { withSig } from "@retenix/shared";
import { z } from "zod";
import { router, signedProcedure } from "../trpc";

export const sendRouter = router({
  execute: signedProcedure.input(withSig(z.unknown())).mutation(() => {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "send.execute — module 15" });
  }),
});
