// intent.parse (doc 09) — the compiler from natural language to DRAFT policy
// objects. Never to actions, never to calldata: the response is only ever
// rendered as draft cards (doc 10) that require a signature to become
// anything ("policies, not prompts", PS-4.2).
//
// Pipeline: rate limit → region-filtered asset enum + system prompt → one
// stateless model call behind the schema wall → deterministic post-processing
// → provenance event → respond. The utterance is stored for display/audit
// only and is never re-fed to any model or execution path (guardrails 6/7).
import { randomUUID } from "node:crypto";
import { events } from "@retenix/db";
import { eligibleAssets } from "@retenix/registry";
import { policyDraftFor, type PolicyDraft } from "@retenix/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { env } from "@/env";
import { resolveParse } from "../lib/draft";
import { CONFIDENCE_NOTE, RATE_LIMIT_MESSAGE } from "../lib/intent-copy";
import { takeIntentParseSlot } from "../lib/intent-rate-limit";
import { RETENIX_INTENT_SYSTEM } from "../lib/intent-system";
import { INTENT_TIMEOUT_MS, intentModel, parseIntent } from "../lib/parse-intent";
import { gatedProcedure, router } from "../trpc";

// The verbatim response contract (doc 09 §API). `adviceFooter` is the PS-10.7
// "not investment advice" flag — true whenever the basket's numbers are the
// model's proposal rather than the user's own; doc 10 renders the footer from
// it (field name recorded in HANDOFF).
export type IntentParseResponse =
  | {
      ok: true;
      draftId: string;
      draft: PolicyDraft;
      confidenceNote: string;
      adviceFooter: boolean;
    }
  | { ok: false; decline: { message: string; suggestions: string[] } };

export const intentRouter = router({
  parse: gatedProcedure
    .input(z.object({ text: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }): Promise<IntentParseResponse> => {
      if (!takeIntentParseSlot(ctx.session.userId)) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: RATE_LIMIT_MESSAGE,
        });
      }

      // The region-filtered enum is built per request (docs 04/05): a
      // blocked-region user's parser literally cannot name SPYx. SOL/ETH are
      // eligible everywhere, so the tuple is never empty.
      const region = ctx.session.region;
      // doc 18 F11: a user who has not answered the decay question cannot even
      // NAME a leveraged token — the enum omits it, so it is unrepresentable
      // rather than rejected later (the same posture as region narrowing).
      const leveragedUnlocked = ctx.session.leveragedUnlocked;
      const ids = eligibleAssets(region, { leveragedUnlocked }).map((a) => a.id) as [
        string,
        ...string[],
      ];

      const outcome = await parseIntent({
        model: intentModel(env.ANTHROPIC_API_KEY),
        schema: policyDraftFor(ids),
        system: RETENIX_INTENT_SYSTEM(ids),
        prompt: input.text,
        timeoutMs: INTENT_TIMEOUT_MS,
      });

      const resolved = resolveParse(outcome, {
        region,
        utterance: input.text,
        leveragedUnlocked,
      });

      // Provenance (guardrails 6/7): a parse VERDICT — a draft, or the model's
      // own "nothing here" — is recorded as `intent.parsed`. Availability
      // failures (no-object / timeout / outage) write nothing: no verdict
      // existed, and the red-team invariant is "DB writes limited to
      // intent.parsed".
      const parsedAt = new Date().toISOString();
      const draftId = randomUUID();

      if (resolved.kind === "draft") {
        await ctx.db.insert(events).values({
          userId: ctx.session.userId,
          type: "intent.parsed",
          payloadJson: {
            draftId,
            utterance: input.text,
            parsedAt,
            outcome: "draft",
            draft: resolved.draft,
            adviceFooter: resolved.adviceFooter,
            droppedAssetIds: resolved.droppedAssetIds,
          },
        });
        return {
          ok: true,
          draftId,
          draft: resolved.draft,
          confidenceNote: CONFIDENCE_NOTE,
          adviceFooter: resolved.adviceFooter,
        };
      }

      if (resolved.cause === "empty") {
        await ctx.db.insert(events).values({
          userId: ctx.session.userId,
          type: "intent.parsed",
          payloadJson: {
            draftId,
            utterance: input.text,
            parsedAt,
            outcome: "decline",
          },
        });
      }

      return { ok: false, decline: resolved.decline };
    }),
});
