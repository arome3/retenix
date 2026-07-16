// The one place Retenix talks to a model (doc 09). AI SDK 7 deprecated
// generateObject — generateText + Output.object is the only sanctioned shape
// (G10); never reintroduce generateObject here or anywhere else.
//
// The call is stateless by design: one system prompt, one user message, no
// tools, no history (guardrail 7 — prompt-injection blast radius is one
// draft). Every failure maps to a decline outcome; a stack trace must never
// escape this module.
import { createAnthropic } from "@ai-sdk/anthropic";
import {
  NoObjectGeneratedError,
  Output,
  generateText,
  type LanguageModel,
} from "ai";
import type { z } from "zod";
import type { ParseOutcome } from "./draft";

/** Spec-pinned model string (tech spec §8; recorded in doc 00's version table). */
export const INTENT_MODEL_ID = "claude-sonnet-4-5";

/** 15 s ceiling (doc 09) — a slow parse degrades to a decline, never a hang. */
export const INTENT_TIMEOUT_MS = 15_000;

/**
 * Provider factory — the `anthropic("claude-sonnet-4-5")` of the spec block.
 * The key is injected so the app routes it through the typed env module and
 * the eval harness (a script outside the app) can pass its own.
 */
export function intentModel(apiKey: string): LanguageModel {
  const anthropic = createAnthropic({ apiKey });
  return anthropic(INTENT_MODEL_ID);
}

export interface ParseIntentArgs {
  model: LanguageModel;
  /** The region-narrowed PolicyDraft schema (policyDraftFor(ids)). */
  schema: z.ZodType;
  /** RETENIX_INTENT_SYSTEM over the same region ids. */
  system: string;
  /** The single user utterance — DATA, not instructions. */
  prompt: string;
  timeoutMs?: number;
  /** Test seam: the generate function (defaults to the real generateText). */
  generate?: typeof generateText;
}

/** One utterance in, one outcome out — never a throw. */
export async function parseIntent(args: ParseIntentArgs): Promise<ParseOutcome> {
  const generate = args.generate ?? generateText;
  try {
    const { output } = await generate({
      model: args.model,
      output: Output.object({ schema: args.schema }),
      system: args.system, // includes injection defenses; refuses out-of-registry assets
      prompt: args.prompt,
      timeout: args.timeoutMs ?? INTENT_TIMEOUT_MS,
    });
    return { kind: "output", raw: output };
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err)) {
      // The model produced something the schema wall refused → graceful
      // re-prompt (guardrail 5).
      return { kind: "no-object" };
    }
    // Timeout, outage, credentials — parsing is never on an execution path,
    // so availability failures degrade UX only.
    return { kind: "unavailable" };
  }
}
