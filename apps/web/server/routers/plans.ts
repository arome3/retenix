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
  plansRevokePayloadSchema,
  plansSetAutonomyPayloadSchema,
  withSig,
  type PlansActivatePayload,
  type PlansRevokePayload,
} from "@retenix/shared";
import { REGISTRY } from "@retenix/registry";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { resolveActivation } from "../lib/activate";
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
