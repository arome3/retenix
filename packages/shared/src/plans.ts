// Plan lifecycle wire contracts (doc 10) — the signed-mutation payload
// schemas, the autonomy-dial semantics, and the guardian/legacy params_json
// shapes. Shared for the same reason sweep.ts is: the client signs the raw
// payload (canonicalJson over the envelope), so client and server must parse
// the exact same shape — drift here breaks signatures, not just types.
//
// Asset ids are shape-checked only (z.string()) — @retenix/registry depends
// on this package, so region/registry validation happens in the web layer
// against the per-request enum (the plan-params.ts precedent, doc 08).
import { z } from "zod";
import { cadenceSchema } from "./plan-params";

// --- autonomy dial (doc 10, PROPOSED — implement exactly, never redesign) ---

export const AUTONOMY_LEVELS = ["observe", "propose", "confirm", "auto"] as const;
export const autonomySchema = z.enum(AUTONOMY_LEVELS);
export type Autonomy = z.infer<typeof autonomySchema>;

/** "Act autonomously (default for Broker — the product premise; caps protect)". */
export const DEFAULT_BROKER_AUTONOMY: Autonomy = "auto";

export interface AutonomyBehavior {
  /** The worker schedules executions at all (false = Observe). */
  schedules: boolean;
  /** Observe: write a `proposal` system receipt instead of executing. */
  writesProposalReceipt: boolean;
  /** Propose/Confirm: execution waits for the user; expires at period end. */
  needsUserConfirm: boolean;
  /** Act-with-confirmation: additionally surface a prompt card on Home. */
  homePromptCard: boolean;
}

/** The doc-10 behavior matrix (PROPOSED), as flags the worker consumes.
 *  Stored per plan in params_json.autonomy; the contract enforces BOUNDS —
 *  autonomy is a server-side execution mode within them. */
export const AUTONOMY_BEHAVIOR: Record<Autonomy, AutonomyBehavior> = {
  observe: { schedules: false, writesProposalReceipt: true, needsUserConfirm: false, homePromptCard: false },
  propose: { schedules: true, writesProposalReceipt: false, needsUserConfirm: true, homePromptCard: false },
  confirm: { schedules: true, writesProposalReceipt: false, needsUserConfirm: true, homePromptCard: true },
  auto: { schedules: true, writesProposalReceipt: false, needsUserConfirm: false, homePromptCard: false },
};

/** Dial labels in canon copy (decision surface — G12 applies). */
export const AUTONOMY_LABELS: Record<Autonomy, string> = {
  observe: "Observe",
  propose: "Propose",
  confirm: "Act with confirmation",
  auto: "Act autonomously",
};

// --- draft sections as they cross the wire (edits re-enter the exact
// --- validation parsed drafts went through — doc 10 security note) ---

export const brokerSectionSchema = z.object({
  cadence: cadenceSchema,
  amountUsd: z.number().positive().max(1000),
  basket: z
    .array(z.object({ assetId: z.string().min(1), pct: z.number() }))
    .min(1)
    .max(5),
});
export type BrokerSection = z.infer<typeof brokerSectionSchema>;

export const guardianSectionSchema = z.object({
  maxDrawdownPct: z.number().min(1).max(90).optional(),
  weeklyCapUsd: z.number().positive().max(5000).optional(),
});
export type GuardianSection = z.infer<typeof guardianSectionSchema>;

export const legacySectionSchema = z.object({
  beneficiaryEmail: z.string().email(),
  inactivityDays: z.number().min(30).max(3650),
});
export type LegacySection = z.infer<typeof legacySectionSchema>;

// --- relayed-auth tuple (bigints never cross the wire — HANDOFF 00) ---

export const relayedAuthSchema = z.object({
  /** authNonces(owner) at signing time, as a decimal string. */
  nonce: z.string().regex(/^\d+$/),
  /** personal_sign over the 32-byte policy digest (policy-digest.ts). */
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
export type RelayedAuth = z.infer<typeof relayedAuthSchema>;

// --- signed-mutation payloads (withSig envelopes wrap these) ---

export const plansActivatePayloadSchema = z.object({
  draftId: z.uuid(),
  accept: z.object({
    broker: z.boolean(),
    guardian: z.boolean(),
    legacy: z.boolean(),
  }),
  edits: z
    .object({
      broker: brokerSectionSchema.optional(),
      guardian: guardianSectionSchema.optional(),
      legacy: legacySectionSchema.optional(),
    })
    .optional(),
  /** Broker card dial position at hire (default DEFAULT_BROKER_AUTONOMY). */
  autonomy: autonomySchema.optional(),
  /** Owner personal_sign over createPlanDigest — required when the activation
   *  creates a contract plan (broker, or guardian merging into one). */
  createPlanAuth: relayedAuthSchema.optional(),
  /** Typed hook for the legacy section's enrollEstate digest — the enrollment
   *  relay itself is module 14's; accepted and stored, never relayed here. */
  enrollEstateAuth: relayedAuthSchema.optional(),
});
export type PlansActivatePayload = z.infer<typeof plansActivatePayloadSchema>;

export const plansRevokePayloadSchema = z.object({
  planId: z.uuid(),
  /** Required when the card has onchain authority (contract_plan_id set). */
  revokeAuth: relayedAuthSchema.optional(),
  /** Guardian-card revoke = revoke-and-recreate the shared plan WITHOUT its
   *  caps (contract plans are immutable) — the recreate's createPlan auth. */
  recreateAuth: relayedAuthSchema.optional(),
});
export type PlansRevokePayload = z.infer<typeof plansRevokePayloadSchema>;

export const plansPausePayloadSchema = z.object({ planId: z.uuid() });
export type PlansPausePayload = z.infer<typeof plansPausePayloadSchema>;

export const plansSetAutonomyPayloadSchema = z.object({
  planId: z.uuid(),
  autonomy: autonomySchema,
});
export type PlansSetAutonomyPayload = z.infer<typeof plansSetAutonomyPayloadSchema>;

// --- params_json shapes for the non-broker cards (broker rows satisfy
// --- brokerParamsSchema in plan-params.ts; these are the other two kinds) ---

export const guardianParamsSchema = z.object({
  maxDrawdownPct: z.number().optional(),
  weeklyCapUsd: z.number().optional(),
  /** Standalone guardian: caps stored, no plan to guard yet (doc 10 step 5). */
  waiting: z.boolean().optional(),
});
export type GuardianParams = z.infer<typeof guardianParamsSchema>;

export const legacyParamsSchema = legacySectionSchema;
export type LegacyParams = z.infer<typeof legacyParamsSchema>;
