/*
 * C13 security-page contract (doc 15) — the revoke-all-without-liquidation
 * payload and the delegation-panel wire types. The typed word lives here so
 * client and server agree on the one sanctioned heavy confirmation
 * (TS-14.5: friction-free dismissal is abusable by a hostile session to
 * sabotage automation quietly — the word makes it deliberate).
 */
import { z } from "zod";

/** C6 typedWord for "Dismiss all staff" — doc 10/13/15: Revoke-all ONLY. */
export const REVOKE_ALL_TYPED_WORD = "REVOKE";

export const SECURITY_EVENTS = {
  /** Audit row for a revoke-all relay (never a feed row — the per-plan
   *  plan.revoked events carry the visible receipts). */
  revokeAll: "security.revoke_all",
} as const;

/** Signed payload of security.revokeAll — the owner's signature over the
 *  doc-07 revokeAll digest, nonce as decimal string (kill's convention). */
export const securityRevokeAllPayloadSchema = z.object({
  nonce: z.string().regex(/^\d+$/),
  signature: z.string().min(1).max(300),
});
export type SecurityRevokeAllPayload = z.infer<typeof securityRevokeAllPayloadSchema>;

// ---------------------------------------------------------------------------
// Delegation panel wire types (consumed by C13; produced from the OQ5
// provisional parse + best-effort chain truth)
// ---------------------------------------------------------------------------

export type DelegateKind = "ua" | "claim" | "unknown";

export interface DelegationRow {
  chainId: number;
  /** Display name — the delegation panel is a sanctioned naming surface. */
  network: string;
  delegated: boolean;
  /** Present only when delegated: which audited program (or, honestly, the
   *  unknown delegate's address — TS-14.4's whole point). */
  delegate?: { kind: DelegateKind; address?: string };
}

export type DelegationsResult =
  | { unavailable: true }
  | { unavailable: false; rows: DelegationRow[]; asOf: string };
