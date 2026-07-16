/*
 * activity.feed (doc 11; tech spec §13 TS-13.1) — the S4 feed source: a
 * cursor-paginated union of
 *   - executions (worker receipts: buys/blocks/skips/refunds), scoped to the
 *     user via executions → jobs → plans.userId, included only when
 *     receipt_text <> '' (module 08's law — in-flight and mid-retry rows carry
 *     the empty string), and
 *   - events rows whose type is in the shared feed allowlist (plan lifecycle,
 *     sweep receipts; kill/estate types land in modules 13/14).
 *
 * Sentences are the STORED strings, byte-verbatim (CONFLICTS #18): this route
 * never composes, reorders, or authors receipt text, and never emits a fee
 * value that is not fees_json passed through (G8). Rows whose stored sentence
 * is missing are skipped, never fabricated.
 *
 * Cursor design: keyset over the canonical sort key
 * (date_trunc('milliseconds', created_at), id). The ms-truncation is
 * load-bearing — timestamptz stores microseconds while JS Dates and ISO
 * cursors carry milliseconds, so comparing at full precision can skip rows
 * that fall between the truncated cursor and the cursor row's real µs value.
 * Truncating on the SQL side makes the SQL order and the TS merge comparator
 * provably identical. Page size 30 (PROPOSED, doc 11).
 */
import {
  FEED_EVENT_TYPES,
  eventSentence,
  eventVariant,
  executionVariant,
  extractFundingSources,
  feeTotalsSchema,
  feedAgentFrom,
  isUaTxIdFormat,
  sweepLegsToDetail,
  type ExecutionStatus,
  type FeedDetail,
  type FeedItem,
} from "@retenix/shared";
import { events, executions, jobs, plans } from "@retenix/db";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { gatedProcedure, router } from "../trpc";

const PAGE_SIZE = 30; // PROPOSED (doc 11) — W3 design review

export type FeedFilter = "all" | "trades" | "blocked" | "system";

/** Trades = executed + failed-refunded; Blocked = blocked; System = events. */
const EXEC_STATUSES_FOR: Record<FeedFilter, ExecutionStatus[]> = {
  all: ["finished", "refunded", "blocked", "failed"],
  trades: ["finished", "refunded", "failed"],
  blocked: ["blocked"],
  system: [],
};

const EVENT_TYPES_FOR: Record<FeedFilter, readonly string[]> = {
  all: FEED_EVENT_TYPES,
  system: FEED_EVENT_TYPES,
  trades: [],
  blocked: [],
};

// ---------------------------------------------------------------------------
// Cursor codec — opaque base64url({ at: ISO-ms, id: uuid }); any garbage is a
// BAD_REQUEST, never a 500.
// ---------------------------------------------------------------------------

const cursorPayloadSchema = z.object({ at: z.iso.datetime(), id: z.uuid() });

interface Cursor {
  atDate: Date;
  id: string;
}

const encodeCursor = (at: Date, id: string): string =>
  Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString("base64url");

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = cursorPayloadSchema.parse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return { atDate: new Date(parsed.at), id: parsed.id };
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "bad cursor — reload the feed",
    });
  }
}

/** Keyset predicate: rows strictly after the cursor in (at desc, id desc)
 *  order, via Postgres row-value comparison on the canonical ms-key. */
const afterCursor = (
  atCol: typeof executions.createdAt | typeof events.createdAt,
  idCol: typeof executions.id | typeof events.id,
  c: Cursor,
): SQL =>
  sql`(date_trunc('milliseconds', ${atCol}), ${idCol}) < (${c.atDate}::timestamptz, ${c.id}::uuid)`;

const msKeyDesc = (
  atCol: typeof executions.createdAt | typeof events.createdAt,
  idCol: typeof executions.id | typeof events.id,
): SQL => sql`date_trunc('milliseconds', ${atCol}) desc, ${idCol} desc`;

// ---------------------------------------------------------------------------
// Row → FeedItem assembly (pure mapping; text passthrough only)
// ---------------------------------------------------------------------------

interface MergedRow {
  id: string; // raw uuid (merge tiebreak — lowercase-hex sorts like PG uuid)
  createdAt: Date;
  item: FeedItem | null; // null = malformed stored row → skipped, not invented
}

interface ExecRow {
  id: string;
  createdAt: Date;
  status: ExecutionStatus;
  receiptText: string;
  uaTxId: string | null;
  feesJson: unknown;
  quoteJson: unknown;
  planId: string;
  kind: "broker" | "guardian" | "legacy";
}

function execToRow(row: ExecRow): MergedRow {
  const variant = executionVariant(row.status);
  if (variant === null) return { id: row.id, createdAt: row.createdAt, item: null };
  const qj = (row.quoteJson ?? {}) as { uaDetail?: unknown; quote?: unknown };
  const fees = feeTotalsSchema.safeParse(row.feesJson);
  const sources = extractFundingSources(qj.uaDetail, qj.quote);
  const detail: FeedDetail = { planId: row.planId };
  if (fees.success) detail.fees = fees.data;
  if (sources.length > 0) detail.sources = sources;
  if (isUaTxIdFormat(row.uaTxId)) detail.uaTxId = row.uaTxId;
  return {
    id: row.id,
    createdAt: row.createdAt,
    item: {
      id: `ex_${row.id}`,
      at: row.createdAt.toISOString(),
      variant,
      sentence: row.receiptText,
      agent: row.kind,
      detail,
    },
  };
}

interface EventRow {
  id: string;
  createdAt: Date;
  type: string;
  payloadJson: unknown;
}

function eventToRow(row: EventRow): MergedRow {
  const variant = eventVariant(row.type);
  const sentence = eventSentence(row.type, row.payloadJson);
  if (variant === null || sentence === null) {
    return { id: row.id, createdAt: row.createdAt, item: null };
  }
  const payload = row.payloadJson as Record<string, unknown>;
  const detail: FeedDetail = {};
  if (typeof payload?.planId === "string") detail.planId = payload.planId;
  if (row.type === "sweep.receipt") {
    const fees = feeTotalsSchema.safeParse(payload?.fees);
    if (fees.success) detail.fees = fees.data;
    const legs = sweepLegsToDetail(payload);
    if (legs.length > 0) detail.legs = legs;
  }
  return {
    id: row.id,
    createdAt: row.createdAt,
    item: {
      id: `ev_${row.id}`,
      at: row.createdAt.toISOString(),
      variant,
      sentence,
      agent: feedAgentFrom(payload?.kind),
      detail: Object.keys(detail).length > 0 ? detail : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

export interface FeedPage {
  items: FeedItem[];
  nextCursor?: string;
}

export const activityRouter = router({
  // gatedProcedure (not the §13 letter's protected): every asset/portfolio
  // surface composes off the gate per module 04's binding note — receipts
  // expose executions, fees, and tx links. Gated ⊃ protected. (HANDOFF flag.)
  feed: gatedProcedure
    .input(
      z.object({
        // .nullish(), not .optional(): tRPC v11 sends null for the first
        // page (initialPageParam = initialCursor ?? null).
        cursor: z.string().max(300).nullish(),
        filter: z.enum(["all", "trades", "blocked", "system"]),
      }),
    )
    .query(async ({ ctx, input }): Promise<FeedPage> => {
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      const userId = ctx.session.userId;
      const fetchLimit = PAGE_SIZE + 1; // +1 per source ⇒ hasMore is decidable

      const execStatuses = EXEC_STATUSES_FOR[input.filter];
      const execRows: ExecRow[] =
        execStatuses.length === 0
          ? []
          : ((await ctx.db
              .select({
                id: executions.id,
                createdAt: executions.createdAt,
                status: executions.status,
                receiptText: executions.receiptText,
                uaTxId: executions.uaTxId,
                feesJson: executions.feesJson,
                quoteJson: executions.quoteJson,
                planId: jobs.planId,
                kind: plans.kind,
              })
              .from(executions)
              .innerJoin(jobs, eq(executions.jobId, jobs.id))
              .innerJoin(plans, eq(jobs.planId, plans.id))
              .where(
                and(
                  eq(plans.userId, userId),
                  ne(executions.receiptText, ""),
                  inArray(executions.status, execStatuses),
                  cursor
                    ? afterCursor(executions.createdAt, executions.id, cursor)
                    : undefined,
                ),
              )
              .orderBy(msKeyDesc(executions.createdAt, executions.id))
              .limit(fetchLimit)) as ExecRow[]);

      const eventTypes = EVENT_TYPES_FOR[input.filter];
      const eventRows: EventRow[] =
        eventTypes.length === 0
          ? []
          : await ctx.db
              .select({
                id: events.id,
                createdAt: events.createdAt,
                type: events.type,
                payloadJson: events.payloadJson,
              })
              .from(events)
              .where(
                and(
                  eq(events.userId, userId),
                  inArray(events.type, [...eventTypes]),
                  cursor
                    ? afterCursor(events.createdAt, events.id, cursor)
                    : undefined,
                ),
              )
              .orderBy(msKeyDesc(events.createdAt, events.id))
              .limit(fetchLimit);

      // Merge desc by (ms, id) — identical semantics to the SQL order; the
      // uuid string compare matches PG's uuid ordering (canonical lowercase
      // hex is byte-ordered).
      const merged = [...execRows.map(execToRow), ...eventRows.map(eventToRow)].sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );

      const page = merged.slice(0, PAGE_SIZE);
      const last = page[page.length - 1];
      const nextCursor =
        merged.length > PAGE_SIZE && last !== undefined
          ? encodeCursor(last.createdAt, last.id)
          : undefined;

      return {
        // Malformed stored rows (no sentence) are dropped, never invented;
        // the cursor advances over CONSUMED rows, so nothing is re-scanned.
        items: page.flatMap((r) => (r.item === null ? [] : [r.item])),
        nextCursor,
      };
    }),
});
