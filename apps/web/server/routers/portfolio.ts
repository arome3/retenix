import { events, portfolioSnapshots, users } from "@retenix/db";
import { REGISTRY } from "@retenix/registry";
import {
  acceptableAddresses,
  bucketSnapshots,
  CHART_RANGES,
  extractSellFill,
  RANGE_CONFIG,
  networkName,
  SELL_RECEIPT_EVENT,
  sellRecordPayloadSchema,
  sellReceiptText,
  withSig,
  type ChartPoint,
  type FeeTotals,
} from "@retenix/shared";
import { parseFeeTotals, pollToTerminal } from "@retenix/ua";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  computeHoldings,
  defaultHoldingsDeps,
  holdingsCache,
  sellEnabled,
  type HoldingsResponse,
} from "../lib/holdings";
import { serverUa } from "../lib/ua";
import { gatedProcedure, gatedSignedProcedure, router } from "../trpc";

export const portfolioRouter = router({
  // The brokerage statement (doc 12, TS-13.1). Composes off gatedProcedure —
  // NOT §13's literal protectedProcedure — per the binding modules-04/06/09/
  // 10/11 convention: holdings are asset data, and gated ⊃ protected.
  //
  // Contract (doc 12 verbatim) + documented extensions: costBasisUsd/deltaUsd/
  // deltaPct are null when basis is unknowable ("—", return omitted — never
  // guessed), markStale drives the doc-01 stale marker, asOf keys the cache,
  // qtyHuman survives to sell-all, unattributedBuys feeds the dev banner.
  //
  // Failure honesty (account.summary precedent): serve the last-known
  // statement with its OLD asOf when sources are down; with no last-known,
  // an honest error — never a fabricated number, never a spinner over money.
  holdings: gatedProcedure.query(
    async ({ ctx }): Promise<HoldingsResponse> => {
      const { userId } = ctx.session;

      const fresh = holdingsCache.fresh(userId);
      if (fresh) return fresh;

      try {
        const [row] = await ctx.db
          .select({ uaSolAddr: users.uaSolAddr })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        const response = await computeHoldings(ctx.db, defaultHoldingsDeps(), {
          userId,
          uaSolAddr: row?.uaSolAddr ?? "",
        });
        holdingsCache.set(userId, response);
        return response;
      } catch {
        const stale = holdingsCache.stale(userId);
        if (stale) return stale;
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: "portfolio sources unavailable",
        });
      }
    },
  ),

  // C11's data: snapshots aggregated per range (doc 12 — "range switch
  // re-queries snapshots"; helper query beyond §13's list, the modules-02/
  // 06/10 precedent). Last snapshot per bucket, empty buckets stay null —
  // the chart renders them as whitespace gaps, never an interpolation.
  chart: gatedProcedure
    .input(z.object({ range: z.enum(CHART_RANGES) }))
    .query(
      async ({
        ctx,
        input,
      }): Promise<{ points: ChartPoint[]; asOf: string }> => {
        const nowMs = Date.now();
        const { spanMs } = RANGE_CONFIG[input.range];
        const scope = eq(portfolioSnapshots.userId, ctx.session.userId);
        const rows = await ctx.db
          .select({ at: portfolioSnapshots.at, totalUsd: portfolioSnapshots.totalUsd })
          .from(portfolioSnapshots)
          .where(
            spanMs === null
              ? scope
              : and(scope, gte(portfolioSnapshots.at, new Date(nowMs - spanMs))),
          )
          .orderBy(asc(portfolioSnapshots.at));
        return {
          points: bucketSnapshots(
            rows.map((r) => ({ at: r.at.toISOString(), totalUsd: r.totalUsd })),
            input.range,
            nowMs,
          ),
          asOf: new Date(nowMs).toISOString(),
        };
      },
    ),

  // Top-up prompt (doc 12 renders; doc 08 emits). The filter is load-bearing:
  // the SAME event type also fires with cause revoked/paused (executor.ts) —
  // only an insufficient-buying-power skip on an OPTED-IN plan may prompt.
  // Separate from `holdings` on purpose: that route serves stale from its
  // cache, and a prompt must never freeze into a stale statement. Window is
  // 7 days (PROPOSED) — a month-old skip is history, not a prompt. Dismissal
  // is client sessionStorage (PROPOSED; the sweep card's dismissal has a
  // server event because doc 06 mandates one — this one doesn't).
  topUpPrompt: gatedProcedure.query(
    async ({
      ctx,
    }): Promise<{ shortUsd: number | null; at: string } | null> => {
      const since = new Date(Date.now() - 7 * 86_400_000);
      const [row] = await ctx.db
        .select({ payloadJson: events.payloadJson, createdAt: events.createdAt })
        .from(events)
        .where(
          and(
            eq(events.userId, ctx.session.userId),
            eq(events.type, "execution.skipped"),
            gte(events.createdAt, since),
            sql`${events.payloadJson}->>'cause' = 'insufficient-buying-power'`,
            sql`${events.payloadJson}->>'topUpOptIn' = 'true'`,
          ),
        )
        .orderBy(desc(events.createdAt))
        .limit(1);
      if (!row) return null;
      const shortUsd = (row.payloadJson as { shortUsd?: unknown }).shortUsd;
      return {
        shortUsd:
          typeof shortUsd === "number" && Number.isFinite(shortUsd)
            ? shortUsd
            : null,
        at: row.createdAt.toISOString(),
      };
    },
  ),

  // Sell-from-detail report (doc 12, PROPOSED — sell-all only, behind the
  // flag). Single-phase where sweep is two-phase, deliberately: the user
  // picks ONE asset explicitly and their Magic signature over the UA root
  // hash is the money authorization; the server's job here is verification
  // and the exactly-once receipt. Everything ledgered is re-derived from the
  // server's own poll (outcome, owners, qty, usd, fees) — the client's only
  // claims are which asset and which transactionId. Signature-gated per
  // doc 00 (gate first so a FORBIDDEN never burns a nonce).
  recordSell: gatedSignedProcedure
    .input(withSig(sellRecordPayloadSchema))
    .mutation(async ({ ctx, input }) => {
      if (!sellEnabled()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "selling is not enabled",
        });
      }
      const payload = sellRecordPayloadSchema.parse(input.payload);
      const { userId, eoaAddr } = ctx.session;

      const asset = REGISTRY.find((a) => a.id === payload.assetId);
      if (!asset) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "unknown asset" });
      }

      // Server-side verification (sweep report mechanics): poll to terminal,
      // then check the payload's owner fields against this session's account.
      let polled: { outcome: string; t: Record<string, unknown> };
      try {
        polled = await pollToTerminal(serverUa(eoaAddr), payload.transactionId, {
          intervalMs: 1500,
          timeoutMs: 6000,
        });
      } catch {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "couldn't verify the sale yet — your holdings will reflect it once it settles",
        });
      }
      if (polled.outcome !== "finished") {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            polled.outcome === "refunded"
              ? "the sale didn't complete — everything stayed put"
              : "the sale is still settling — check back shortly",
        });
      }

      const [userRow] = await ctx.db
        .select({ uaSolAddr: users.uaSolAddr })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const owners = extractOwners(polled.t).map((o) => o.toLowerCase());
      const mine = [eoaAddr, userRow?.uaSolAddr ?? ""]
        .filter(Boolean)
        .map((o) => o.toLowerCase());
      if (owners.length > 0 && !owners.some((o) => mine.includes(o))) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "that sale did not come from this account",
        });
      }

      const fill = extractSellFill([polled.t], acceptableAddresses(asset));
      let fees: FeeTotals | undefined;
      try {
        fees = parseFeeTotals(polled.t as { feeQuotes?: unknown[] });
      } catch {
        fees = undefined;
      }

      const receipt = {
        assetId: asset.id,
        qty: fill.qty,
        usd: fill.usd,
        outcome: "finished",
        transactionId: payload.transactionId,
        network: networkName(asset.chainId), // copy-canon-allow
        receipt: sellReceiptText(asset.ticker),
        ...(fees ? { fees } : {}),
      };

      // Exactly-once, serialized on the users row (the sweep-report shape):
      // a retried or concurrent report converges on the first receipt.
      const written = await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`select id from users where id = ${userId} for update`);
        const existing = await tx
          .select({ id: events.id })
          .from(events)
          .where(
            and(
              eq(events.userId, userId),
              eq(events.type, SELL_RECEIPT_EVENT),
              sql`${events.payloadJson}->>'transactionId' = ${payload.transactionId}`,
            ),
          )
          .limit(1);
        if (existing.length > 0) return false;
        await tx.insert(events).values({
          userId,
          type: SELL_RECEIPT_EVENT,
          payloadJson: receipt,
        });
        return true;
      });

      holdingsCache.drop(userId);
      return { recorded: written, receipt: receipt.receipt };
    }),
});

/** Best-effort owner extraction from the (unfrozen, doc 03 OQ5) polled
 *  payload — the sweep verifier's exact rule. */
function extractOwners(t: Record<string, unknown>): string[] {
  const owners: string[] = [];
  const sao = t.smartAccountOptions as { ownerAddress?: unknown } | undefined;
  if (typeof sao?.ownerAddress === "string") owners.push(sao.ownerAddress);
  if (typeof t.sender === "string" && t.sender) owners.push(t.sender);
  return owners;
}
