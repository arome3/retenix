import { randomUUID } from "node:crypto";
import { events, users, type Db } from "@retenix/db";
import {
  SEND_EVENTS,
  SEND_INVITE_COPY,
  maskEmail,
  networkName,
  receivedReceipt,
  refundedReceipt,
  sendExecutePayloadSchema,
  sendFailedReceipt,
  sendToSchema,
  sendUnverifiedReceipt,
  sentReceipt,
  withdrawReceipt,
  withSig,
  extractSellFill,
  type FeeTotals,
  type SendAuthorizePayload,
  type SendAuthorizedRecord,
  type SendAuthorizedTarget,
  type SendReceiptPayload,
  type SendReportPayload,
  type SendResolveResult,
} from "@retenix/shared";
import {
  CHAIN_ID,
  SUPPORTED_TOKEN_TYPE,
  getPrimaryAssets,
  parseFeeTotals,
  pollToTerminal,
  primaryTokenFor,
} from "@retenix/ua";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/env";
import { hashEmail } from "@/lib/emailHash";
import { sendInviteEmail } from "../lib/invite";
import { extractOwners } from "../lib/kill";
import {
  SEND_SETTLE_CHAIN_ID,
  computeUnits,
  defaultResolveDeps,
  isStable,
  primaryPriceAndBalance,
  resolveRecipient,
  verifyDelivery,
  withdrawToken,
  type SendResolution,
  type WithdrawToken,
} from "../lib/send";
import { takeSendResolveSlot } from "../lib/send-rate-limit";
import { getSettleBlockNumber, getSettleLogs } from "../lib/settle-rpc";
import { serverUa } from "../lib/ua";
import { gatedProcedure, gatedSignedProcedure, router } from "../trpc";
import type { Context } from "../context";

/*
 * Send / withdraw (doc 15) — money leaves as easily as it arrived: USDC to an
 * email/ENS/address from the unified balance (network-free), or an explicit
 * asset to an external address on a chosen network (withdraw — the single
 * sanctioned network-choice surface, CONFLICTS #16).
 *
 * The sweep/kill two-phase discipline, single-leg:
 *   authorize — the server re-resolves the recipient itself (the
 *     email→address mapping can never be swapped client-side), prices the
 *     amount, and pins the EXACT target (receiver, token, units) in a
 *     send.authorized event under the users-row lock. Unregistered email →
 *     invite; NO funds path exists there by design.
 *   [browser] — lib/send-runner.ts creates the transfer against the PINNED
 *     target, signs headless (magicSigner), polls, reports.
 *   report — every claim re-verified: the server's OWN poll, owner match,
 *     asset+amount match against the pinned units. The sender's receipt
 *     states only what was verified. The RECIPIENT's receipt (the one
 *     cross-user write in the codebase) additionally requires CHAIN TRUTH: a
 *     Transfer(→recipient) of ≥98% of the pinned units on the settle chain
 *     after the authorize block — a hostile sender session can burn its own
 *     money, but it cannot mint a false "Received" in someone else's feed.
 */

/** An un-receipted authorization younger than this blocks a new one. */
const AUTHORIZE_STALE_MS = 10 * 60_000;

/** Legs are terminal when reported — one quick poll, never the 180s default. */
const VERIFY_POLL = { intervalMs: 1500, timeoutMs: 6000 };

/** Verified transfer qty may differ from the pinned units by at most this
 *  before the leg is unverifiable (fee-side rounding on some routes). */
const QTY_TOLERANCE = 0.05;

type DbOrTx = Pick<Db, "execute">;

async function findSendReceipt(
  db: DbOrTx,
  userId: string,
  executionId: string,
): Promise<SendReceiptPayload | null> {
  const res = await db.execute(
    sql`select payload_json from events
        where user_id = ${userId} and type = ${SEND_EVENTS.receipt}
          and payload_json->>'executionId' = ${executionId}
        limit 1`,
  );
  const row = res.rows[0] as { payload_json: SendReceiptPayload } | undefined;
  return row?.payload_json ?? null;
}

/** One transactionId binds to exactly ONE receipt/ledger-bearing row for this
 *  user (kill's assertTxIdUnbound, extended with send.receipt). */
async function assertTxIdUnbound(
  tx: DbOrTx,
  userId: string,
  transactionId: string,
  executionId: string,
): Promise<void> {
  const res = await tx.execute(
    sql`select 1 from events
        where user_id = ${userId}
          and type in (${SEND_EVENTS.receipt}, 'sell.receipt', 'kill.leg')
          and payload_json->>'transactionId' = ${transactionId}
          and coalesce(payload_json->>'executionId', '') <> ${executionId}
        limit 1`,
  );
  if (res.rows.length > 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "that transaction is already recorded",
    });
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — authorize
// ---------------------------------------------------------------------------

export type SendAuthorization =
  | { invited: true; message: string }
  | { invited: false; executionId: string; target: SendAuthorizedTarget };

/** 7-day invite dedupe — repeated sends to the same missing email don't spam. */
const INVITE_DEDUPE_MS = 7 * 24 * 3600_000;

async function inviteUnregistered(
  ctx: Context & { session: NonNullable<Context["session"]> },
  email: string,
): Promise<SendAuthorization> {
  const { userId } = ctx.session;
  const emailHash = hashEmail(email);
  const cutoff = new Date(Date.now() - INVITE_DEDUPE_MS);
  const recent = await ctx.db.execute(
    sql`select 1 from events
        where user_id = ${userId} and type = ${SEND_EVENTS.invited}
          and payload_json->>'emailHash' = ${emailHash}
          and created_at > ${cutoff}
        limit 1`,
  );
  if (recent.rows.length === 0) {
    // Best-effort email (loud log-fallback inside); the audit row records
    // whether it actually went out. NO funds path exists here by design.
    const { sent } = await sendInviteEmail({
      to: email,
      link: `${env.APP_BASE_URL}/welcome`,
    });
    await ctx.db.insert(events).values({
      userId,
      type: SEND_EVENTS.invited,
      payloadJson: { emailHash, emailSent: sent },
    });
  }
  return { invited: true, message: SEND_INVITE_COPY };
}

async function authorize(
  ctx: Context & { session: NonNullable<Context["session"]> },
  payload: SendAuthorizePayload,
): Promise<SendAuthorization> {
  const { userId, eoaAddr } = ctx.session;

  // Withdraws carry BOTH asset and network (the user's explicit choice);
  // plain sends carry NEITHER — a half-specified pair is a malformed client.
  const isWithdraw = payload.asset !== undefined || payload.chainId !== undefined;
  if (isWithdraw && (payload.asset === undefined || payload.chainId === undefined)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "asset and destination must be chosen together",
    });
  }
  if (isWithdraw && payload.to.kind !== "address") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "withdrawals go to an address",
    });
  }

  const token: WithdrawToken = isWithdraw
    ? withdrawToken(payload.asset as string, payload.chainId as number)
    : (() => {
        // Plain sends: USDC on the settle chain (doc 15 PROPOSED default —
        // "routing dissolves"; the recipient's UA aggregates regardless).
        const usdc = primaryTokenFor(SUPPORTED_TOKEN_TYPE.USDC, SEND_SETTLE_CHAIN_ID);
        if (!usdc) throw new Error("USDC settle token missing"); // unreachable (SDK constant)
        return {
          chainId: SEND_SETTLE_CHAIN_ID,
          address: usdc.address,
          decimals: usdc.realDecimals,
          symbol: "USDC",
          tokenType: SUPPORTED_TOKEN_TYPE.USDC as string,
        };
      })();

  const resolution: SendResolution = await resolveRecipient(
    ctx.db,
    payload.to,
    defaultResolveDeps(),
    { solanaTarget: token.chainId === CHAIN_ID.SOLANA_MAINNET },
  );

  if (resolution.kind === "unregistered") {
    return inviteUnregistered(ctx, resolution.email);
  }

  // A self-send would only burn fees — refuse honestly.
  if (resolution.address.toLowerCase() === eoaAddr.toLowerCase()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "that's this account's own address",
    });
  }

  // The sender self-identifies for the recipient's receipt; the claim is
  // verified against the session user's email_hash, and only the MASKED form
  // ever persists. Absent → the recipient sees the sender's truncated
  // address (addresses are sanctioned in receipts, DS-9.3).
  let senderDisplay: string | undefined;
  if (resolution.kind === "registered") {
    if (payload.senderEmail) {
      const [me] = await ctx.db
        .select({ emailHash: users.emailHash })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!me || hashEmail(payload.senderEmail) !== me.emailHash) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "sender email doesn't match this account",
        });
      }
      senderDisplay = maskEmail(payload.senderEmail);
    } else {
      senderDisplay = `${eoaAddr.slice(0, 6)}…${eoaAddr.slice(-4)}`;
    }
  }

  // Price + spendable check off the user's own primary-asset feed (the kill
  // denomination source). Stables move 1:1; sol/eth/bnb need a live price.
  const primaries = await getPrimaryAssets(serverUa(eoaAddr));
  const { price, amountInUSD } = primaryPriceAndBalance(primaries, token.tokenType);
  const effectivePrice = isStable(token.tokenType) ? 1 : price;
  if (!effectivePrice) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "couldn't price that asset right now — try again shortly",
    });
  }
  if (payload.amountUsd > amountInUSD) {
    const cap = Math.max(0, Math.floor(amountInUSD * 100) / 100).toFixed(2);
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `you can send up to $${cap} right now`,
    });
  }
  const amountUnits = computeUnits(payload.amountUsd, effectivePrice, token.decimals);

  // Registered-email sends: pin the settle-chain block BEFORE the transfer
  // exists — the delivery proof scans forward from here.
  let fromBlock: number | undefined;
  if (resolution.kind === "registered") {
    try {
      fromBlock = await getSettleBlockNumber();
    } catch {
      fromBlock = undefined; // proof degrades to "unproven" — never blocks the send
    }
  }

  const target: SendAuthorizedTarget = {
    address: resolution.address,
    token: {
      chainId: token.chainId,
      address: token.address,
      decimals: token.decimals,
      symbol: token.symbol,
    },
    amountUnits,
    amountUsd: payload.amountUsd,
    display: resolution.display,
    withdraw: isWithdraw,
    ...(resolution.kind === "registered"
      ? { recipientUserId: resolution.recipientUserId, senderDisplay }
      : {}),
  };

  const executionId = randomUUID();
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select id from users where id = ${userId} for update`);

    // Double-tap guard (sweep verbatim): a recent authorization that never
    // produced a receipt means a send may still be running in another tab.
    const staleCutoff = new Date(Date.now() - AUTHORIZE_STALE_MS);
    const recent = await tx.execute(
      sql`select payload_json->>'executionId' as execution_id
          from events
          where user_id = ${userId} and type = ${SEND_EVENTS.authorized}
            and created_at > ${staleCutoff}
          order by created_at desc`,
    );
    for (const row of recent.rows as { execution_id: string }[]) {
      const receipted = await tx.execute(
        sql`select 1 from events
            where user_id = ${userId} and type = ${SEND_EVENTS.receipt}
              and payload_json->>'executionId' = ${row.execution_id}
            limit 1`,
      );
      if (receipted.rows.length === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "a send is already in progress",
        });
      }
    }

    const record: SendAuthorizedRecord & { fromBlock?: number; tokenType: string } = {
      executionId,
      target,
      ...(fromBlock !== undefined ? { fromBlock } : {}),
      tokenType: token.tokenType,
      createdAt: new Date().toISOString(),
    };
    await tx.insert(events).values({
      userId,
      type: SEND_EVENTS.authorized,
      payloadJson: record,
    });
  });

  return { invited: false, executionId, target };
}

// ---------------------------------------------------------------------------
// Phase 2 — report → the sender's receipt (+ the chain-proven recipient row)
// ---------------------------------------------------------------------------

async function report(
  ctx: Context & { session: NonNullable<Context["session"]> },
  payload: SendReportPayload,
): Promise<SendReceiptPayload> {
  const { userId, eoaAddr } = ctx.session;

  const authRes = await ctx.db.execute(
    sql`select payload_json from events
        where user_id = ${userId} and type = ${SEND_EVENTS.authorized}
          and payload_json->>'executionId' = ${payload.executionId}
        limit 1`,
  );
  const authRow = authRes.rows[0] as
    | {
        payload_json: SendAuthorizedRecord & { fromBlock?: number; tokenType: string };
      }
    | undefined;
  if (!authRow) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "unknown or unauthorized execution",
    });
  }
  const auth = authRow.payload_json;
  const { target } = auth;

  const existing = await findSendReceipt(ctx.db, userId, payload.executionId);
  if (existing) return existing;

  // --- Re-derive the terminal truth from the server's OWN poll -------------
  let outcome: SendReceiptPayload["outcome"];
  let serverVerified = false;
  let error: string | undefined = payload.error;
  let fees: FeeTotals | undefined;
  let feeSource: SendReceiptPayload["feeSource"];
  let extractedQty: number | null = null;

  if (!payload.transactionId) {
    // The client never got a transactionId — nothing was sent.
    outcome = "failed";
    serverVerified = true;
  } else {
    let polled: { outcome: string; t: Record<string, unknown> };
    try {
      polled = (await pollToTerminal(
        serverUa(eoaAddr),
        payload.transactionId,
        VERIFY_POLL,
      )) as { outcome: string; t: Record<string, unknown> };
    } catch {
      // Verification impossible right now — the runner re-reports (kill's
      // still-settling posture); never receipt a claim we couldn't check.
      throw new TRPCError({
        code: "CONFLICT",
        message: "still settling — report again shortly",
      });
    }
    if (polled.outcome === "timeout") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "still settling — report again shortly",
      });
    }

    // Owner match: a tx provably from another account is a failed claim.
    const owners = extractOwners(polled.t).map((o) => o.toLowerCase());
    if (owners.length > 0 && !owners.includes(eoaAddr.toLowerCase())) {
      outcome = "failed";
      serverVerified = true;
      error = "did not match this account";
    } else {
      // Fees: settled parse when the payload carries real numbers (an
      // all-zero parse means "no fee data", not "free"), else the quote (G8).
      try {
        const parsed = parseFeeTotals(polled.t as { feeQuotes: never[] });
        if (!Object.values(parsed).every((v) => v === 0)) {
          fees = parsed;
          feeSource = "settled";
        }
      } catch {
        // fall through to the quote
      }
      if (!fees && payload.feesQuoted) {
        fees = payload.feesQuoted;
        feeSource = "quoted";
      }

      if (polled.outcome === "refunded") {
        outcome = "refunded";
        serverVerified = true;
      } else {
        // finished — the pinned token must have LEFT the account, in the
        // pinned amount (±tolerance): a session-only attacker must not turn
        // an unrelated finished tx into a "sent" receipt.
        const fill = extractSellFill([polled.t], [target.token.address]);
        extractedQty = fill.qty;
        const expected = Number(target.amountUnits);
        const qtyOk =
          fill.qty !== null &&
          Number.isFinite(expected) &&
          expected > 0 &&
          Math.abs(fill.qty - expected) / expected <= QTY_TOLERANCE;
        if (qtyOk) {
          outcome = "finished";
          serverVerified = true;
        } else {
          outcome = "unverified";
          error ??=
            fill.qty === null
              ? "couldn't confirm what moved"
              : "amount did not match";
        }
      }
    }
  }

  // --- Sender receipt text (templates only — never inline strings) ---------
  const zeroFees: FeeTotals = { gas: 0, service: 0, lp: 0, total: 0 };
  const receiptText =
    outcome === "finished"
      ? target.withdraw
        ? withdrawReceipt({
            usd: target.amountUsd,
            symbol: target.token.symbol,
            toDisplay: target.display,
            network: networkName(target.token.chainId), // copy-canon-allow (receipt context)
            fees: fees ?? zeroFees,
          })
        : sentReceipt({
            usd: target.amountUsd,
            toDisplay: target.display,
            fees: fees ?? zeroFees,
          })
      : outcome === "refunded"
        ? refundedReceipt(target.amountUsd)
        : outcome === "unverified"
          ? sendUnverifiedReceipt(target.amountUsd, target.display)
          : sendFailedReceipt(target.amountUsd, target.display);

  // --- Delivery proof for the recipient's receipt (chain truth only) -------
  let delivered: boolean | null = null;
  if (
    outcome === "finished" &&
    serverVerified &&
    target.recipientUserId &&
    auth.fromBlock !== undefined
  ) {
    delivered = await verifyDelivery(
      { getLogs: getSettleLogs },
      {
        tokenAddress: target.token.address,
        tokenDecimals: target.token.decimals,
        recipient: target.address,
        amountUnits: target.amountUnits,
        fromBlock: auth.fromBlock,
      },
    );
  }

  const receipt: SendReceiptPayload = {
    executionId: payload.executionId,
    receipt: receiptText,
    outcome,
    usd: target.amountUsd,
    toDisplay: target.display,
    withdraw: target.withdraw,
    ...(target.withdraw
      ? {
          network: networkName(target.token.chainId), // copy-canon-allow (receipt context)
          symbol: target.token.symbol,
        }
      : {}),
    ...(payload.transactionId ? { transactionId: payload.transactionId } : {}),
    serverVerified,
    ...(fees ? { fees, feeSource: feeSource ?? "none" } : {}),
    ...(target.withdraw &&
    outcome === "finished" &&
    serverVerified &&
    (auth.tokenType === "sol" || auth.tokenType === "eth")
      ? {
          // A ledger-tracked asset left the account — decrement the portfolio
          // ledger (portfolio-fills.ts withdrawFillFromEvent consumes this).
          ledgerFill: {
            assetId: auth.tokenType,
            qty: extractedQty ?? (Number(target.amountUnits) || null),
            usd: target.amountUsd,
          },
        }
      : {}),
    ...(error ? { error } : {}),
  };

  // Exactly-once write, serialized on the SENDER's row only (never the
  // recipient's — lock-ordering hazard; only the sender's report can write
  // this pair, so the sender's lock covers both rows).
  return await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select id from users where id = ${userId} for update`);
    const raced = await findSendReceipt(tx, userId, payload.executionId);
    if (raced) return raced; // a concurrent report won — converge
    if (payload.transactionId) {
      await assertTxIdUnbound(tx, userId, payload.transactionId, payload.executionId);
    }
    await tx.insert(events).values({
      userId,
      type: SEND_EVENTS.receipt,
      payloadJson: receipt,
    });
    if (delivered === true && target.recipientUserId && target.senderDisplay) {
      await tx.insert(events).values({
        userId: target.recipientUserId,
        type: SEND_EVENTS.received,
        payloadJson: {
          executionId: payload.executionId,
          receipt: receivedReceipt(target.amountUsd, target.senderDisplay),
          usd: target.amountUsd,
          fromDisplay: target.senderDisplay,
          ...(payload.transactionId ? { transactionId: payload.transactionId } : {}),
        },
      });
    }
    return receipt;
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const sendRouter = router({
  /** Form-time preview. Never exposes an address for email lookups (the
   *  registered/unregistered oracle is rate-limited); ENS misses and bad
   *  checksums come back as statuses, not errors — the form renders them.
   *  The authorize phase re-resolves everything regardless. */
  resolve: gatedProcedure
    .input(z.object({ to: sendToSchema }))
    .query(async ({ ctx, input }): Promise<SendResolveResult> => {
      if (!takeSendResolveSlot(ctx.session.userId)) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "too many lookups — give it a minute",
        });
      }
      try {
        const resolution = await resolveRecipient(ctx.db, input.to);
        if (resolution.kind === "unregistered") {
          return { status: "unregistered", display: resolution.display };
        }
        if (resolution.kind === "registered") {
          return { status: "registered", display: resolution.display };
        }
        return {
          status: "resolved",
          address: resolution.address,
          display: resolution.display,
        };
      } catch (err) {
        if (err instanceof TRPCError && err.code === "BAD_REQUEST") {
          return {
            status: err.message === "name not found" ? "not-found" : "invalid",
            display: input.to.value.trim(),
          };
        }
        throw err;
      }
    }),

  execute: gatedSignedProcedure
    .input(withSig(sendExecutePayloadSchema))
    .mutation(async ({ ctx, input }) => {
      const payload = input.payload;
      if (payload.phase === "authorize") {
        return {
          phase: "authorize" as const,
          authorization: await authorize(ctx, payload),
        };
      }
      return { phase: "report" as const, receipt: await report(ctx, payload) };
    }),
});
