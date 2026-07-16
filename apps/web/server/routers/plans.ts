// plans.activate / revoke / pause / resume / setAutonomy (doc 10) — the
// activation flow and lifecycle. Every route is a signed mutation (the owner's
// personal_sign over {route, inputHash, nonce, expiry}); the create/revoke
// bodies additionally carry an owner personal_sign over doc 07's onchain
// digest, so the signature covers the exact caps/hash/period written to the
// contract — a compromised server cannot show $50 and write $500.
//
// The only path from a draft to onchain authority is plans.activate; there is
// no auto-activate anywhere. A card stays `draft` until the relay confirms
// inclusion — never optimistic-active.
import { events, plans, type Db } from "@retenix/db";
import {
  DEFAULT_BROKER_AUTONOMY,
  autonomySchema,
  brokerHiredReceipt,
  guardianHiredReceipt,
  nextCadenceRun,
  planDismissedReceipt,
  planPausedReceipt,
  planResumedReceipt,
  plansActivatePayloadSchema,
  plansPausePayloadSchema,
  plansRecreatePayloadSchema,
  plansRevokePayloadSchema,
  plansSetAutonomyPayloadSchema,
  revokePlanDigest,
  withSig,
  type Autonomy,
  type BrokerSection,
  type PlansActivatePayload,
  type PlansRecreatePayload,
  type PlansRevokePayload,
} from "@retenix/shared";
import { REGISTRY } from "@retenix/registry";
import { TRPCError } from "@trpc/server";
import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { resolveActivation, type ActivateResolution } from "../lib/activate";
import { CADENCE_PERIOD_SECS } from "../lib/activation-mapping";
import { readStoredDraft } from "../lib/draft-store";
import { getPlanRelay } from "../lib/relay-factory";
import { gatedProcedure, gatedSignedProcedure, router } from "../trpc";

const ticker = (id: string) =>
  REGISTRY.find((a) => a.id === id)?.ticker ?? id.toUpperCase();

/** Every card this activation created — the client refreshes S3 from these. */
interface ActivatedCard {
  planId: string;
  kind: "broker" | "guardian" | "legacy";
  status: "active" | "draft";
  contractPlanId: number | null;
}

/** A card as S3 renders it (doc 10). */
export interface PlanCardData {
  planId: string;
  kind: "broker" | "guardian" | "legacy";
  status: "draft" | "active" | "paused" | "revoked";
  contractPlanId: number | null;
  params: unknown;
}

/** The two digests an active-card edit signs (prepareRecreate). */
export interface PrepareRecreate {
  revoke: { digest: string; nonce: string };
  createPlan: {
    digest: string;
    nonce: string;
    capPerExecUsd: number;
    capPerPeriodUsd: number;
  };
}

/** The C6 preview + the exact digest the owner signs (prepareActivation). */
export interface PrepareActivation {
  broker: import("@retenix/shared").BrokerSection | null;
  guardian: import("@retenix/shared").GuardianSection | null;
  legacy: import("@retenix/shared").LegacySection | null;
  standaloneGuardian: boolean;
  createPlan: {
    /** 32-byte digest the owner personal_signs. */
    digest: string;
    /** authNonces(owner) at build time — returned in createPlanAuth. */
    nonce: string;
    capPerExecUsd: number;
    capPerPeriodUsd: number;
    periodSecs: number;
    assetIds: string[];
    assetListHash: string;
  } | null;
}

export const plansRouter = router({
  // -------------------------------------------------------------------------
  // list — the S3 roster (non-revoked cards, newest first). Read-only gated.
  // -------------------------------------------------------------------------
  list: gatedProcedure.query(async ({ ctx }): Promise<{ cards: PlanCardData[] }> => {
    const rows = await ctx.db
      .select({
        id: plans.id,
        kind: plans.kind,
        status: plans.status,
        contractPlanId: plans.contractPlanId,
        paramsJson: plans.paramsJson,
      })
      .from(plans)
      .where(eq(plans.userId, ctx.session.userId));
    return {
      cards: rows
        .filter((r) => r.status !== "revoked")
        .map((r) => ({
          planId: r.id,
          kind: r.kind,
          status: r.status,
          contractPlanId: r.contractPlanId,
          params: r.paramsJson,
        })),
    };
  }),

  // -------------------------------------------------------------------------
  // recentBlocks — plan ids with an `execution.blocked` event in the last
  // window, for C3's amber flash (doc 10 task 11). This is the interim source
  // until module 11's activity.feed drives the flash; the worker writes
  // execution.blocked with the DB planId, so cards match directly.
  // -------------------------------------------------------------------------
  recentBlocks: gatedProcedure
    .input(z.object({ sinceMs: z.number().int().positive().max(3_600_000).default(120_000) }))
    .query(async ({ ctx, input }): Promise<{ planIds: string[] }> => {
      const since = new Date(Date.now() - input.sinceMs);
      const rows = await ctx.db
        .select({ payloadJson: events.payloadJson })
        .from(events)
        .where(
          and(
            eq(events.userId, ctx.session.userId),
            eq(events.type, "execution.blocked"),
            gte(events.createdAt, since),
          ),
        );
      const planIds = [
        ...new Set(
          rows
            .map((r) => (r.payloadJson as { planId?: string }).planId)
            .filter((id): id is string => typeof id === "string"),
        ),
      ];
      return { planIds };
    }),

  // -------------------------------------------------------------------------
  // prepareActivation (PROPOSED helper query) — the C6 preview: resolve the
  // draft, show the EXACT onchain terms, and hand back the createPlan digest
  // the owner must personal_sign. The digest is built with the AUTHORITATIVE
  // nonce (read server-side), so the signature the client returns commits to
  // precisely the caps/hash/period the server will relay (doc 10 security).
  // Read-only; no signature (the activation itself is the signed mutation).
  // -------------------------------------------------------------------------
  prepareActivation: gatedProcedure
    .input(plansActivatePayloadSchema.pick({ draftId: true, accept: true, edits: true }))
    .query(async ({ ctx, input }): Promise<PrepareActivation> => {
      const stored = await readStoredDraft(ctx.db, ctx.session.userId, input.draftId);
      if (!stored) {
        throw new TRPCError({ code: "NOT_FOUND", message: "draft expired — parse again" });
      }
      const resolved = resolveActivation({
        draft: stored.draft,
        accept: input.accept,
        edits: input.edits,
        region: ctx.session.region,
      });
      if (!resolved.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: resolved.reason });
      }

      const out: PrepareActivation = {
        broker: resolved.broker ?? null,
        guardian: resolved.guardian ?? null,
        legacy: resolved.legacy ?? null,
        standaloneGuardian: resolved.standaloneGuardian,
        createPlan: null,
      };

      if (resolved.broker && resolved.onchain) {
        const relay = getPlanRelay();
        const nonce = await relay.authNonce(ctx.session.eoaAddr);
        const digest = await relay.buildCreatePlanDigest({
          capPerExec: resolved.onchain.capPerExec,
          capPerPeriod: resolved.onchain.capPerPeriod,
          periodSecs: resolved.onchain.periodSecs,
          assetListHash: resolved.onchain.assetListHash,
          nonce,
        });
        out.createPlan = {
          digest,
          nonce: nonce.toString(),
          capPerExecUsd: Number(resolved.onchain.capPerExec) / 1e6,
          capPerPeriodUsd: Number(resolved.onchain.capPerPeriod) / 1e6,
          periodSecs: resolved.onchain.periodSecs,
          assetIds: resolved.onchain.assetIds,
          assetListHash: resolved.onchain.assetListHash,
        };
      }
      return out;
    }),

  // -------------------------------------------------------------------------
  // activate — draft → owner signature → relayed createPlan → active card(s).
  // -------------------------------------------------------------------------
  activate: gatedSignedProcedure
    .input(withSig(plansActivatePayloadSchema))
    .mutation(async ({ ctx, input }): Promise<{ cards: ActivatedCard[] }> => {
      const payload = input.payload as PlansActivatePayload;
      const userId = ctx.session.userId;
      const region = ctx.session.region;
      const owner = ctx.session.eoaAddr;

      const stored = await readStoredDraft(ctx.db, userId, payload.draftId);
      if (!stored) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "that draft has expired — parse it again",
        });
      }

      const resolved = resolveActivation({
        draft: stored.draft,
        accept: payload.accept,
        edits: payload.edits,
        region,
      });
      if (!resolved.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: resolved.reason });
      }

      const cards: ActivatedCard[] = [];

      // --- broker (+ merged guardian) → ONE contract plan ---
      if (resolved.broker && resolved.onchain) {
        if (!payload.createPlanAuth) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "createPlan signature required to hire the Broker",
          });
        }
        const relay = getPlanRelay();
        const nonce = BigInt(payload.createPlanAuth.nonce);

        let planId: bigint;
        let txHash: string;
        try {
          const res = await relay.createPlan({
            owner,
            capPerExec: resolved.onchain.capPerExec,
            capPerPeriod: resolved.onchain.capPerPeriod,
            periodSecs: resolved.onchain.periodSecs,
            assetListHash: resolved.onchain.assetListHash,
            assetIds: resolved.onchain.assetIds,
            nonce,
            ownerSig: payload.createPlanAuth.signature,
          });
          planId = res.planId;
          txHash = res.txHash;
        } catch (err) {
          // Relay failure degrades to "queued" — the card stays draft, never
          // optimistic-active (doc 10 security). Surfaced as a retryable error.
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "Queued — we'll confirm your plan when it lands. Nothing was activated.",
            cause: err,
          });
        }

        const contractPlanId = Number(planId);
        const activatedAt = new Date();
        const autonomy = payload.autonomy ?? DEFAULT_BROKER_AUTONOMY;
        const periodSecs = CADENCE_PERIOD_SECS[resolved.broker.cadence];

        const brokerParams = {
          cadence: resolved.broker.cadence,
          amountUsd: resolved.broker.amountUsd,
          basket: resolved.broker.basket,
          capPerExecUsd: Number(resolved.onchain.capPerExec) / 1e6,
          capPerPeriodUsd: Number(resolved.onchain.capPerPeriod) / 1e6,
          periodSecs,
          nextRunAt: nextCadenceRun(
            resolved.broker.cadence,
            activatedAt,
            activatedAt,
          ).toISOString(),
          autonomy,
          topUpOptIn: false,
        };

        const [brokerRow] = await ctx.db
          .insert(plans)
          .values({
            userId,
            kind: "broker",
            paramsJson: brokerParams,
            contractPlanId,
            status: "active",
            activatedAt,
          })
          .returning({ id: plans.id });
        cards.push({
          planId: brokerRow.id,
          kind: "broker",
          status: "active",
          contractPlanId,
        });

        // Guardian card is the UI face of the SAME onchain plan's caps
        // (doc 07 mapping) — shares contract_plan_id.
        if (resolved.guardian) {
          const [gRow] = await ctx.db
            .insert(plans)
            .values({
              userId,
              kind: "guardian",
              paramsJson: {
                maxDrawdownPct: resolved.guardian.maxDrawdownPct,
                weeklyCapUsd: resolved.guardian.weeklyCapUsd,
                sharesPlanId: contractPlanId,
              },
              contractPlanId,
              status: "active",
              activatedAt,
            })
            .returning({ id: plans.id });
          cards.push({
            planId: gRow.id,
            kind: "guardian",
            status: "active",
            contractPlanId,
          });
        }

        await ctx.db.insert(events).values([
          {
            userId,
            type: "plan.activated",
            payloadJson: {
              planId: brokerRow.id,
              kind: "broker",
              contractPlanId,
              txHash,
              receipt: brokerHiredReceipt({
                amountUsd: resolved.broker.amountUsd,
                cadence: resolved.broker.cadence,
                tickers: resolved.broker.basket.map((l) => ticker(l.assetId)),
              }),
            },
          },
          ...(resolved.guardian
            ? [
                {
                  userId,
                  type: "plan.activated",
                  payloadJson: {
                    kind: "guardian",
                    contractPlanId,
                    receipt: guardianHiredReceipt(resolved.guardian),
                  },
                },
              ]
            : []),
        ]);
      } else if (resolved.standaloneGuardian && resolved.guardian) {
        // Standalone guardian (doc 10 step 5 PROPOSED): caps with no plan to
        // guard yet — stored as a draft applied to the next broker activation.
        // No contract write.
        const [gRow] = await ctx.db
          .insert(plans)
          .values({
            userId,
            kind: "guardian",
            paramsJson: {
              maxDrawdownPct: resolved.guardian.maxDrawdownPct,
              weeklyCapUsd: resolved.guardian.weeklyCapUsd,
              waiting: true,
            },
            contractPlanId: null,
            status: "draft",
          })
          .returning({ id: plans.id });
        cards.push({
          planId: gRow.id,
          kind: "guardian",
          status: "draft",
          contractPlanId: null,
        });
      }

      // --- legacy → Estate (module 14 owns enrollment; we record the card
      //     and stash the enrollEstate signature hook) ---
      if (resolved.legacy) {
        const [lRow] = await ctx.db
          .insert(plans)
          .values({
            userId,
            kind: "legacy",
            paramsJson: {
              beneficiaryEmail: resolved.legacy.beneficiaryEmail,
              inactivityDays: resolved.legacy.inactivityDays,
              // Typed hook for module 14: the enrollEstate digest signature, if
              // the client bundled it. The enrollment relay itself is doc 14's.
              enrollEstateAuth: payload.enrollEstateAuth ?? null,
            },
            contractPlanId: null,
            status: "draft",
          })
          .returning({ id: plans.id });
        cards.push({
          planId: lRow.id,
          kind: "legacy",
          status: "draft",
          contractPlanId: null,
        });
      }

      return { cards };
    }),

  // -------------------------------------------------------------------------
  // prepareRevoke (PROPOSED helper query) — the revoke digest + authoritative
  // nonce the owner personal_signs. Returns null digest for a draft/standalone
  // card (no onchain authority → revoked in the DB only).
  // -------------------------------------------------------------------------
  prepareRevoke: gatedProcedure
    .input(plansPausePayloadSchema)
    .query(
      async ({
        ctx,
        input,
      }): Promise<{ digest: string; nonce: string } | { digest: null }> => {
        const plan = await requireOwnedPlan(ctx.db, ctx.session.userId, input.planId);
        if (plan.contractPlanId === null) return { digest: null };
        const relay = getPlanRelay();
        const nonce = await relay.authNonce(ctx.session.eoaAddr);
        const digest = revokePlanDigest(relay.domain, {
          id: BigInt(plan.contractPlanId),
          nonce,
        });
        return { digest, nonce: nonce.toString() };
      },
    ),

  // -------------------------------------------------------------------------
  // revoke — relayed revokePlanFor → card(s) revoked. Security-critical: this
  // zeroes onchain authority (PS-F5-AC2). A guardian card sharing a broker's
  // plan revokes BOTH (they are one onchain plan) — honestly reflected.
  // -------------------------------------------------------------------------
  revoke: gatedSignedProcedure
    .input(withSig(plansRevokePayloadSchema))
    .mutation(async ({ ctx, input }): Promise<{ revoked: string[] }> => {
      const payload = input.payload as PlansRevokePayload;
      const plan = await requireOwnedPlan(ctx.db, ctx.session.userId, payload.planId);

      // A draft/standalone card (no onchain authority) is revoked in the DB only.
      if (plan.contractPlanId === null) {
        await ctx.db
          .update(plans)
          .set({ status: "revoked" })
          .where(eq(plans.id, plan.id));
        return { revoked: [plan.id] };
      }

      if (!payload.revokeAuth) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "revoke signature required",
        });
      }

      try {
        await getPlanRelay().revokePlanFor({
          owner: ctx.session.eoaAddr,
          planId: BigInt(plan.contractPlanId),
          nonce: BigInt(payload.revokeAuth.nonce),
          ownerSig: payload.revokeAuth.signature,
        });
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Couldn't reach the relay — your card is unchanged. Try again in a moment.",
          cause: err,
        });
      }

      // Every card sharing this onchain plan is now revoked (broker+guardian).
      const siblings = await ctx.db
        .select({ id: plans.id, kind: plans.kind })
        .from(plans)
        .where(
          and(
            eq(plans.userId, ctx.session.userId),
            eq(plans.contractPlanId, plan.contractPlanId),
          ),
        );
      await ctx.db
        .update(plans)
        .set({ status: "revoked" })
        .where(
          and(
            eq(plans.userId, ctx.session.userId),
            eq(plans.contractPlanId, plan.contractPlanId),
          ),
        );

      await ctx.db.insert(events).values(
        siblings.map((s) => ({
          userId: ctx.session.userId,
          type: "plan.revoked",
          payloadJson: {
            planId: s.id,
            contractPlanId: plan.contractPlanId,
            receipt: planDismissedReceipt(s.kind),
          },
        })),
      );

      return { revoked: siblings.map((s) => s.id) };
    }),

  // -------------------------------------------------------------------------
  // prepareRecreate — the two digests (SEQUENTIAL nonces) an active-card edit
  // signs: revoke the old plan (nonce N), create the edited plan (nonce N+1).
  // Contract plans are immutable, so an edit is a revoke-and-recreate (doc 10
  // task 8). Reuses resolveActivation via a synthetic draft from the stored
  // params, so the edit re-enters the same validation a parse did.
  // -------------------------------------------------------------------------
  prepareRecreate: gatedProcedure
    .input(plansRecreatePayloadSchema.pick({ planId: true, edits: true }))
    .query(async ({ ctx, input }): Promise<PrepareRecreate> => {
      const plan = await requireBrokerToRecreate(ctx.db, ctx.session.userId, input.planId);
      const resolved = resolveRecreate(plan, input.edits.broker, ctx.session.region);
      if (!resolved.ok || !resolved.onchain) {
        throw new TRPCError({ code: "BAD_REQUEST", message: resolved.ok ? "no onchain plan" : resolved.reason });
      }
      const relay = getPlanRelay();
      const revokeNonce = await relay.authNonce(ctx.session.eoaAddr);
      const createNonce = revokeNonce + 1n; // sequential (contract _useNonce)
      const revokeDigest = revokePlanDigest(relay.domain, {
        id: BigInt(plan.contractPlanId),
        nonce: revokeNonce,
      });
      const createDigest = await relay.buildCreatePlanDigest({
        capPerExec: resolved.onchain.capPerExec,
        capPerPeriod: resolved.onchain.capPerPeriod,
        periodSecs: resolved.onchain.periodSecs,
        assetListHash: resolved.onchain.assetListHash,
        nonce: createNonce,
      });
      return {
        revoke: { digest: revokeDigest, nonce: revokeNonce.toString() },
        createPlan: {
          digest: createDigest,
          nonce: createNonce.toString(),
          capPerExecUsd: Number(resolved.onchain.capPerExec) / 1e6,
          capPerPeriodUsd: Number(resolved.onchain.capPerPeriod) / 1e6,
        },
      };
    }),

  // -------------------------------------------------------------------------
  // recreate — the active-card edit: revoke old + create new, TWO receipts,
  // one confirmation (doc 10 task 8). The old broker (and any guardian sharing
  // its onchain plan) is revoked; the edited plan is created fresh.
  // -------------------------------------------------------------------------
  recreate: gatedSignedProcedure
    .input(withSig(plansRecreatePayloadSchema))
    .mutation(async ({ ctx, input }): Promise<{ old: string[]; card: ActivatedCard }> => {
      const payload = input.payload as PlansRecreatePayload;
      const owner = ctx.session.eoaAddr;
      const plan = await requireBrokerToRecreate(ctx.db, ctx.session.userId, payload.planId);
      const resolved = resolveRecreate(plan, payload.edits.broker, ctx.session.region);
      if (!resolved.ok || !resolved.onchain || !resolved.broker) {
        throw new TRPCError({ code: "BAD_REQUEST", message: resolved.ok ? "nothing to recreate" : resolved.reason });
      }

      const relay = getPlanRelay();
      // 1. Revoke the old onchain plan (nonce N).
      try {
        await relay.revokePlanFor({
          owner,
          planId: BigInt(plan.contractPlanId),
          nonce: BigInt(payload.revokeAuth.nonce),
          ownerSig: payload.revokeAuth.signature,
        });
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Couldn't reach the relay — your plan is unchanged.",
          cause: err,
        });
      }

      // 2. Create the edited plan (nonce N+1). If this fails after the revoke
      //    landed, the old plan is already revoked — the card is honestly
      //    revoked, and the user re-drafts. (An orphaned revoke is safe: it
      //    only removes authority; nothing over-executes.)
      let newPlanId: bigint;
      let txHash: string;
      try {
        const res = await relay.createPlan({
          owner,
          capPerExec: resolved.onchain.capPerExec,
          capPerPeriod: resolved.onchain.capPerPeriod,
          periodSecs: resolved.onchain.periodSecs,
          assetListHash: resolved.onchain.assetListHash,
          assetIds: resolved.onchain.assetIds,
          nonce: BigInt(payload.createPlanAuth.nonce),
          ownerSig: payload.createPlanAuth.signature,
        });
        newPlanId = res.planId;
        txHash = res.txHash;
      } catch (err) {
        // Old plan is revoked; mark the DB rows to match reality.
        await ctx.db
          .update(plans)
          .set({ status: "revoked" })
          .where(
            and(
              eq(plans.userId, ctx.session.userId),
              eq(plans.contractPlanId, plan.contractPlanId),
            ),
          );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Your old plan was cancelled, but the new one didn't land — re-draft it.",
          cause: err,
        });
      }

      // 3. DB: revoke old rows, insert the edited broker (+ carried guardian).
      const contractPlanId = Number(newPlanId);
      const activatedAt = new Date();
      const autonomy = payload.autonomy ?? (plan.autonomy ?? DEFAULT_BROKER_AUTONOMY);
      const oldRows = await ctx.db
        .select({ id: plans.id, kind: plans.kind })
        .from(plans)
        .where(
          and(
            eq(plans.userId, ctx.session.userId),
            eq(plans.contractPlanId, plan.contractPlanId),
          ),
        );
      await ctx.db
        .update(plans)
        .set({ status: "revoked" })
        .where(
          and(
            eq(plans.userId, ctx.session.userId),
            eq(plans.contractPlanId, plan.contractPlanId),
          ),
        );

      const [brokerRow] = await ctx.db
        .insert(plans)
        .values({
          userId: ctx.session.userId,
          kind: "broker",
          paramsJson: {
            cadence: resolved.broker.cadence,
            amountUsd: resolved.broker.amountUsd,
            basket: resolved.broker.basket,
            capPerExecUsd: Number(resolved.onchain.capPerExec) / 1e6,
            capPerPeriodUsd: Number(resolved.onchain.capPerPeriod) / 1e6,
            periodSecs: resolved.onchain.periodSecs,
            nextRunAt: nextCadenceRun(resolved.broker.cadence, activatedAt, activatedAt).toISOString(),
            autonomy,
            topUpOptIn: false,
          },
          contractPlanId,
          status: "active",
          activatedAt,
        })
        .returning({ id: plans.id });

      if (resolved.guardian) {
        await ctx.db.insert(plans).values({
          userId: ctx.session.userId,
          kind: "guardian",
          paramsJson: {
            maxDrawdownPct: resolved.guardian.maxDrawdownPct,
            weeklyCapUsd: resolved.guardian.weeklyCapUsd,
            sharesPlanId: contractPlanId,
          },
          contractPlanId,
          status: "active",
          activatedAt,
        });
      }

      // Two honest receipts: the old was dismissed, the new was hired.
      await ctx.db.insert(events).values([
        {
          userId: ctx.session.userId,
          type: "plan.revoked",
          payloadJson: { contractPlanId: plan.contractPlanId, receipt: planDismissedReceipt("broker") },
        },
        {
          userId: ctx.session.userId,
          type: "plan.activated",
          payloadJson: {
            planId: brokerRow.id,
            kind: "broker",
            contractPlanId,
            txHash,
            receipt: brokerHiredReceipt({
              amountUsd: resolved.broker.amountUsd,
              cadence: resolved.broker.cadence,
              tickers: resolved.broker.basket.map((l) => ticker(l.assetId)),
            }),
          },
        },
      ]);

      return {
        old: oldRows.map((r) => r.id),
        card: { planId: brokerRow.id, kind: "broker", status: "active", contractPlanId },
      };
    }),

  // -------------------------------------------------------------------------
  // pause / resume — the worker gates scheduling on plans.status === "active"
  // (doc 08 scheduler), so a DB-status flip is an ENFORCED stop. The contract's
  // pausePlan/resumePlan are onlyOwner(msg.sender) with no relayed variant and
  // the owner is gasless — an onchain pause is deferred (HANDOFF). Revoke, the
  // security-critical stop, IS onchain.
  // -------------------------------------------------------------------------
  pause: gatedSignedProcedure
    .input(withSig(plansPausePayloadSchema))
    .mutation(async ({ ctx, input }): Promise<{ planId: string }> => {
      const plan = await requireOwnedPlan(
        ctx.db,
        ctx.session.userId,
        (input.payload as { planId: string }).planId,
      );
      if (plan.status !== "active") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "plan is not active" });
      }
      await ctx.db.update(plans).set({ status: "paused" }).where(eq(plans.id, plan.id));
      await ctx.db.insert(events).values({
        userId: ctx.session.userId,
        type: "plan.paused",
        payloadJson: { planId: plan.id, receipt: planPausedReceipt(plan.kind) },
      });
      return { planId: plan.id };
    }),

  resume: gatedSignedProcedure
    .input(withSig(plansPausePayloadSchema))
    .mutation(async ({ ctx, input }): Promise<{ planId: string }> => {
      const plan = await requireOwnedPlan(
        ctx.db,
        ctx.session.userId,
        (input.payload as { planId: string }).planId,
      );
      if (plan.status !== "paused") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "plan is not paused" });
      }
      await ctx.db.update(plans).set({ status: "active" }).where(eq(plans.id, plan.id));
      await ctx.db.insert(events).values({
        userId: ctx.session.userId,
        type: "plan.resumed",
        payloadJson: { planId: plan.id, receipt: planResumedReceipt(plan.kind) },
      });
      return { planId: plan.id };
    }),

  // -------------------------------------------------------------------------
  // setAutonomy (PROPOSED route) — a signed mutation, NOT a contract write.
  // The contract enforces bounds; autonomy is a server-side execution mode
  // stored on the plan's params_json (doc 10 dial semantics).
  // -------------------------------------------------------------------------
  setAutonomy: gatedSignedProcedure
    .input(withSig(plansSetAutonomyPayloadSchema))
    .mutation(async ({ ctx, input }): Promise<{ planId: string; autonomy: string }> => {
      const { planId, autonomy } = input.payload as {
        planId: string;
        autonomy: string;
      };
      const level = autonomySchema.parse(autonomy);
      const plan = await requireOwnedPlan(ctx.db, ctx.session.userId, planId);
      if (plan.kind !== "broker") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "only Broker plans have an autonomy dial",
        });
      }
      const params = { ...(plan.paramsJson as Record<string, unknown>), autonomy: level };
      await ctx.db.update(plans).set({ paramsJson: params }).where(eq(plans.id, plan.id));
      await ctx.db.insert(events).values({
        userId: ctx.session.userId,
        type: "plan.autonomy_set",
        payloadJson: { planId: plan.id, autonomy: level },
      });
      return { planId: plan.id, autonomy: level };
    }),
});

interface OwnedPlan {
  id: string;
  kind: "broker" | "guardian" | "legacy";
  status: "draft" | "active" | "paused" | "revoked";
  contractPlanId: number | null;
  paramsJson: unknown;
}

interface BrokerToRecreate {
  contractPlanId: number;
  broker: BrokerSection;
  guardian?: { maxDrawdownPct?: number; weeklyCapUsd?: number };
  autonomy?: Autonomy;
}

/** Load an ACTIVE broker card (with any guardian sharing its plan) for an edit. */
async function requireBrokerToRecreate(
  db: Db,
  userId: string,
  planId: string,
): Promise<BrokerToRecreate> {
  const plan = await requireOwnedPlan(db, userId, planId);
  if (plan.kind !== "broker" || plan.status !== "active" || plan.contractPlanId === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "only an active Broker card can be edited",
    });
  }
  const p = plan.paramsJson as {
    cadence: BrokerSection["cadence"];
    amountUsd: number;
    basket: { assetId: string; pct: number }[];
    autonomy?: Autonomy;
  };
  // A guardian sharing this onchain plan carries its caps forward on recreate.
  const [g] = await db
    .select({ paramsJson: plans.paramsJson })
    .from(plans)
    .where(
      and(
        eq(plans.userId, userId),
        eq(plans.kind, "guardian"),
        eq(plans.contractPlanId, plan.contractPlanId),
        eq(plans.status, "active"),
      ),
    )
    .limit(1);
  const gp = g?.paramsJson as
    | { maxDrawdownPct?: number; weeklyCapUsd?: number }
    | undefined;
  return {
    contractPlanId: plan.contractPlanId,
    broker: { cadence: p.cadence, amountUsd: p.amountUsd, basket: p.basket },
    guardian: gp && (gp.maxDrawdownPct !== undefined || gp.weeklyCapUsd !== undefined) ? gp : undefined,
    autonomy: p.autonomy,
  };
}

/** Re-validate the edited broker (+carried guardian) via the activation path. */
function resolveRecreate(
  plan: BrokerToRecreate,
  edit: BrokerSection,
  region: string,
): ActivateResolution {
  // Synthetic draft = the card's current sections; the edit overrides broker.
  const draft = {
    broker: plan.broker,
    guardian: plan.guardian,
  };
  return resolveActivation({
    draft,
    accept: { broker: true, guardian: Boolean(plan.guardian), legacy: false },
    edits: { broker: edit },
    region,
  });
}

/** Fetch a plan the session user owns, or throw NOT_FOUND (never leak others'). */
async function requireOwnedPlan(
  db: Db,
  userId: string,
  planId: string,
): Promise<OwnedPlan> {
  const [row] = await db
    .select({
      id: plans.id,
      kind: plans.kind,
      status: plans.status,
      contractPlanId: plans.contractPlanId,
      paramsJson: plans.paramsJson,
    })
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.userId, userId)))
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "no such plan" });
  }
  return row as OwnedPlan;
}
