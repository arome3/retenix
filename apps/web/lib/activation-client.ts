// Client-side activation helpers (doc 10) — turn a parsed draft into the
// signed `plans.activate` input. The owner personal_signs the createPlan
// digest the server prepared (which committed to the exact caps/hash/period),
// so the signature covers precisely what the card showed.
import type {
  Autonomy,
  BrokerSection,
  GuardianSection,
  LegacySection,
  PolicyDraft,
} from "@retenix/shared";
import { personalSign, signEnvelope } from "@/lib/sign";

/** The sections a parsed draft offers, split for per-card rendering. */
export interface DraftSections {
  broker?: BrokerSection;
  guardian?: GuardianSection;
  legacy?: LegacySection;
}

export function splitDraft(draft: PolicyDraft): DraftSections {
  return {
    broker: draft.broker,
    guardian: draft.guardian,
    legacy: draft.legacy,
  };
}

/**
 * personal_sign the 32-byte createPlan digest. The provider signs the digest
 * bytes under the EIP-191 prefix — exactly what RetenixPolicy._recover (and the
 * relay's recoverDigestSigner) verify. Returns the {nonce, signature} the
 * activation's createPlanAuth expects.
 */
export async function signCreatePlan(
  digest: string,
  nonce: string,
  eoa: string,
): Promise<{ nonce: string; signature: string }> {
  const signature = await personalSign(digest, eoa);
  return { nonce, signature };
}

/** Build the full signed { payload, sig } envelope for plans.activate. */
export async function buildActivateInput(
  payload: {
    draftId: string;
    accept: { broker: boolean; guardian: boolean; legacy: boolean };
    edits?: DraftSections;
    autonomy?: Autonomy;
    createPlanAuth?: { nonce: string; signature: string };
    enrollEstateAuth?: { nonce: string; signature: string };
  },
  eoa: string,
) {
  return signEnvelope("plans.activate", payload, eoa);
}
