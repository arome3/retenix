import { initTRPC, TRPCError } from "@trpc/server";
import { events, type Db } from "@retenix/db";
import {
  buildSignedMessage,
  computeInputHash,
  sigEnvelopeSchema,
} from "@retenix/shared";
import { sql } from "drizzle-orm";
import { verifyMessage } from "ethers";
import { z } from "zod";
import type { Context } from "./context";

const t = initTRPC.context<Context>().create();

export const router = t.router;

// ---------------------------------------------------------------------------
// publicProcedure — no session.
// ---------------------------------------------------------------------------
export const publicProcedure = t.procedure;

// ---------------------------------------------------------------------------
// protectedProcedure — valid Magic session cookie (module 02 implements the
// real check; the context stub keeps this a typed UNAUTHORIZED until then).
// ---------------------------------------------------------------------------
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "sign in required" });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});

// ---------------------------------------------------------------------------
// signedProcedure — protected PLUS a fresh personal_sign payload from the
// user's EOA over { route, inputHash, nonce, expiry }, verified with
// ethers.verifyMessage. Nonces are single-use (strictly greater than the
// last-seen 'sig.nonce' event per user) and expiry is capped at 5 minutes.
// Route inputs use the { payload, sig } envelope from @retenix/shared.
// ---------------------------------------------------------------------------
const SIG_MAX_TTL_SECS = 300;

const envelopeSchema = z.object({
  payload: z.unknown(),
  sig: sigEnvelopeSchema,
});

export const signedProcedure = protectedProcedure.use(
  async ({ ctx, path, getRawInput, next }) => {
    const parsed = envelopeSchema.safeParse(await getRawInput());
    if (!parsed.success) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "signed envelope { payload, sig } required",
      });
    }
    const { payload, sig } = parsed.data;

    const now = Math.floor(Date.now() / 1000);
    if (sig.expiry <= now) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "signature expired" });
    }
    if (sig.expiry > now + SIG_MAX_TTL_SECS) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "expiry exceeds the 5-minute window",
      });
    }

    const message = buildSignedMessage({
      route: path,
      inputHash: computeInputHash(payload),
      nonce: sig.nonce,
      expiry: sig.expiry,
    });

    let signer: string;
    try {
      signer = verifyMessage(message, sig.signature);
    } catch {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid signature" });
    }
    if (signer.toLowerCase() !== ctx.session.eoaAddr.toLowerCase()) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "signer is not the session EOA",
      });
    }

    await consumeNonce(ctx.db, ctx.session.userId, sig.nonce);
    return next();
  },
);

// Single-use enforcement: lock the user row to serialize concurrent attempts,
// then require the nonce to be strictly greater than the last one seen.
async function consumeNonce(db: Db, userId: string, nonce: number) {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from users where id = ${userId} for update`,
    );
    const last = await tx.execute(
      sql`select coalesce(max((payload_json->>'nonce')::numeric), -1) as last
          from events
          where user_id = ${userId} and type = 'sig.nonce'`,
    );
    const lastNonce = Number((last.rows[0] as { last: string | number }).last);
    if (nonce <= lastNonce) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "nonce reused" });
    }
    await tx.insert(events).values({
      userId,
      type: "sig.nonce",
      payloadJson: { nonce },
    });
  });
}

// ---------------------------------------------------------------------------
// claimGatedProcedure — public + claim-token gate (estate.claimStart only).
// Module 14 implements token verification (hash lookup, single-use, expiry);
// the input shape is enforced now.
// ---------------------------------------------------------------------------
export const claimGatedProcedure = publicProcedure.use(
  async ({ getRawInput, next }) => {
    const parsed = z
      .object({ token: z.string().min(1) })
      .safeParse(await getRawInput());
    if (!parsed.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "claim token required",
      });
    }
    return next();
  },
);
