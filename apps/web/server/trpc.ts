import { initTRPC, TRPCError } from "@trpc/server";
import { events, users, type Db } from "@retenix/db";
import {
  buildSignedMessage,
  COMPLIANCE_EVENTS,
  computeInputHash,
  isLeverageUnlocked,
  sigEnvelopeSchema,
} from "@retenix/shared";
import { and, desc, eq, sql } from "drizzle-orm";
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
// gatedProcedure — protected PLUS a passed eligibility gate (doc 04, layer 2).
//
// This is the second of the two deep-link-proof layers (the first is proxy.ts
// on page routes). middleware bypass ≠ data access: even a request that skips
// the edge must not touch an asset route without a completed gate. The region
// column is written "" until the gate finishes (doc 04's finalization), so
// region !== "" IS gatePassed. Read it from the DB per request — the JWT claim
// is unforgeable but can go stale (region is a support-changeable field), and
// the spec's discipline is "authoritative checks server-side per request".
//
// Every asset/portfolio/intent route (docs 05+) composes off this, NOT plain
// protectedProcedure. account.bootstrap is the deliberate exception: it runs
// pre-gate (lib/post-login.ts), so it stays protectedProcedure.
// ---------------------------------------------------------------------------
async function assertGatePassed(
  db: Db,
  userId: string,
): Promise<{ region: string; leveragedUnlocked: boolean }> {
  const [row] = await db
    .select({ region: users.region })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row || !row.region) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "eligibility gate not completed",
    });
  }
  // doc 18 F11's second, orthogonal dimension: region says WHERE an asset may
  // be sold, this says TO WHOM. Read here because the gate already costs one
  // per-request round trip and every asset route composes off it — so no
  // caller can forget it, and `eligibleAssets` stays fail-closed if one does.
  // Newest row wins: the quiz gained a question, so a user may hold a stale
  // 3-answer row alongside a fresh 4-answer one.
  const [quiz] = await db
    .select({ payloadJson: events.payloadJson })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.type, COMPLIANCE_EVENTS.quizPassed),
      ),
    )
    .orderBy(desc(events.createdAt))
    .limit(1);
  const answers = (quiz?.payloadJson as { answers?: unknown } | undefined)
    ?.answers;
  return {
    region: row.region,
    leveragedUnlocked: isLeverageUnlocked(answers),
  };
}

export const gatedProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const { region, leveragedUnlocked } = await assertGatePassed(
    ctx.db,
    ctx.session.userId,
  );
  return next({
    ctx: { ...ctx, session: { ...ctx.session, region, leveragedUnlocked } },
  });
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

async function verifySignedEnvelope(
  db: Db,
  session: { userId: string; eoaAddr: string },
  path: string,
  rawInput: unknown,
): Promise<void> {
  const parsed = envelopeSchema.safeParse(rawInput);
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
  if (signer.toLowerCase() !== session.eoaAddr.toLowerCase()) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "signer is not the session EOA",
    });
  }

  await consumeNonce(db, session.userId, sig.nonce);
}

export const signedProcedure = protectedProcedure.use(
  async ({ ctx, path, getRawInput, next }) => {
    await verifySignedEnvelope(ctx.db, ctx.session, path, await getRawInput());
    return next();
  },
);

// ---------------------------------------------------------------------------
// gatedSignedProcedure — gate AND signature, for signed asset routes
// (doc 06's sweep.execute; docs 13/15 likely follow). Gate runs FIRST so a
// FORBIDDEN gate failure never consumes a nonce.
// ---------------------------------------------------------------------------
export const gatedSignedProcedure = protectedProcedure
  .use(async ({ ctx, next }) => {
    const { region, leveragedUnlocked } = await assertGatePassed(
      ctx.db,
      ctx.session.userId,
    );
    return next({
      ctx: { ...ctx, session: { ...ctx.session, region, leveragedUnlocked } },
    });
  })
  .use(async ({ ctx, path, getRawInput, next }) => {
    await verifySignedEnvelope(ctx.db, ctx.session, path, await getRawInput());
    return next();
  });

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
