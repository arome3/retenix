import { events, portfolioSnapshots, users } from "@retenix/db";
import {
  bucketSnapshots,
  CHART_RANGES,
  RANGE_CONFIG,
  type ChartPoint,
} from "@retenix/shared";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  computeHoldings,
  defaultHoldingsDeps,
  holdingsCache,
  type HoldingsResponse,
} from "../lib/holdings";
import { gatedProcedure, router } from "../trpc";

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
});
