// Estate wire contract (doc 14) — event types, signed-payload schemas, the
// escrowed-tuple shape, beneficiary hashing, and claim-token mechanics. The
// web router, worker keeper/heartbeat, and S5/S6/C8 surfaces all consume THIS
// module; nothing re-encodes these shapes elsewhere (the kill.ts precedent).
//
// Glossary (doc 14, verbatim intent):
// - escrowed tuple: a per-chain EIP-7702 authorization (delegating to
//   RetenixClaim) signed at enrollment, encrypted server-side, bound to the
//   EOA's current nonce and therefore SELF-INVALIDATING on any owner activity.
//   The staleness isn't a bug; it's the dead-man switch.
// - challenge window: the timelock between fireDeadline and the claim opening
//   (claimReadyAt), during which the owner can cancel.
// - heartbeat: Estate.lastCheckIn on Arbitrum, bumped by relayed check-ins
//   from observed any-network activity or the explicit "I'm here" button.
import { concat, getBytes, hexlify, keccak256, randomBytes, sha256, toUtf8Bytes } from "ethers";
import { z } from "zod";
import { ESTATE_CHAIN_IDS, type EstateChainId } from "./contracts";
import { relayedAuthSchema } from "./plans";

// ---------------------------------------------------------------------------
// Event taxonomy (events.type strings). Feed-renderable types also appear in
// feed.ts FEED_EVENT_TYPES and carry a display-ready payload.receipt; the
// rest are audit rows (the sweep.authorized rule) and must NEVER render.
// ---------------------------------------------------------------------------
export const ESTATE_EVENTS = {
  /** feed — enrollment completed (receipt on payload). */
  enrolled: "estate.enrolled",
  /** feed — relayed check-in landed; payload carries the CONFLICTS #13 proof
   *  (either the owner's signed envelope or the observed-activity watermark). */
  checkin: "estate.checkin",
  /** feed — DeadlineFired observed; the countdown is live (C8's backend). */
  countdownStarted: "estate.countdown_started",
  /** feed — Alchemy webhook noticed activity (UX notification ONLY — the
   *  timer moves on observation-confirmed relayed check-ins, never on this). */
  activityNoticed: "estate.activity_noticed",
  /** feed — the claim sequence finished; the estate moved to the heir. */
  claimed: "estate.claimed",
  /** audit — keeper sent the heir email; payload {tokenHash, expiresAt,
   *  summary} is ALSO the claim-token store (hash only, never the token). */
  claimEmailSent: "estate.claim_email_sent",
  /** audit — heir passed token+OTP checks; keeper takes over from here. */
  claimRequested: "estate.claim_requested",
  /** audit — single-use marker written when a token is consumed. */
  claimStarted: "estate.claim_started",
  /** audit — per-chain claim progress (S6 polls these via estate.claimStatus). */
  claimProgress: "estate.claim_progress",
} as const;

// ---------------------------------------------------------------------------
// Escrowed tuples
// ---------------------------------------------------------------------------
const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** One serialized 7702 authorization. chainId 0 is REJECTED here and at the
 *  keeper: a 0-chainId authorization is valid on EVERY chain (cross-chain
 *  replay), which would defeat the per-chain nonce binding. */
export const escrowTupleSchema = z.object({
  chainId: z.number().int().positive(),
  /** The RetenixClaim delegate this authorization points at. */
  address: hexAddress,
  /** The EOA's account nonce AT SIGNING — the self-invalidation binding. */
  nonce: z.number().int().min(0),
  yParity: z.union([z.literal(0), z.literal(1)]),
  r: hex32,
  s: hex32,
});
export type EscrowTuple = z.infer<typeof escrowTupleSchema>;

/** The full escrow set: exactly one tuple per estate chain (doc 14 — the 5
 *  EVM networks; Solana is excluded, no 7702 there). */
export const escrowTupleSetSchema = z
  .array(escrowTupleSchema)
  .length(ESTATE_CHAIN_IDS.length)
  .refine(
    (tuples) => {
      const ids = new Set(tuples.map((t) => t.chainId));
      return ESTATE_CHAIN_IDS.every((id) => ids.has(id));
    },
    { message: "escrow set must cover exactly the 5 estate networks" },
  );

// ---------------------------------------------------------------------------
// Signed-mutation payloads (withSig envelopes wrap these)
// ---------------------------------------------------------------------------
export const estateEnrollPayloadSchema = z.object({
  beneficiaryEmail: z.string().email().max(320),
  /** Shown to the heir on S6 ("You've been named by <name>."). Optional —
   *  PROPOSED (spec-silent): Retenix stores no names, so the owner supplies
   *  one; it is envelope-encrypted with the email, never plaintext at rest. */
  ownerDisplayName: z.string().trim().min(1).max(80).optional(),
  /** Draft range per doc 14; converted to inactivitySecs at enrollment (the
   *  server substitutes DEMO_INACTIVITY_SECS when DEMO_MODE=1 — the schema
   *  never changes). */
  inactivityDays: z.number().int().min(30).max(3650),
  /** Client-minted 32-byte salt for the beneficiary hash preimage. */
  salt: hex32,
  /** Owner personal_sign over enrollEstateDigest(beneficiaryHash,
   *  inactivitySecs, nonce) — the relay verifies recovery before gas. */
  auth: relayedAuthSchema,
  tuples: escrowTupleSetSchema,
});
export type EstateEnrollPayload = z.infer<typeof estateEnrollPayloadSchema>;

/** "I'm here" — the signed envelope itself is the CONFLICTS #13 proof; the
 *  payload only names the source. One tap both bumps lastCheckIn and (if in
 *  countdown) returns the estate to Enrolled — the contract's checkIn does
 *  both in one call (RetenixPolicy "veto by liveness"). */
export const estateCheckInPayloadSchema = z.object({
  source: z.literal("im-here"),
});

/** Silent tuple refresh (login / post-transaction). Protected, not signed:
 *  tuples only ever delegate to the audited RetenixClaim and are useless
 *  before Claimable — a fresh set is strictly-newer coverage, never a grant. */
export const estateRefreshPayloadSchema = z.object({
  tuples: escrowTupleSetSchema,
});

// ---------------------------------------------------------------------------
// Beneficiary hash (PROPOSED preimage; spec fixes keccak(email-salt)):
// keccak256(utf8(lowercase(trim(email))) ‖ salt32). Only the hash goes
// onchain (TS-12.2); email + salt live KMS-encrypted in
// estates.beneficiary_email_enc, revealed only at claim verification.
// ---------------------------------------------------------------------------
export function normalizeBeneficiaryEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Display mask for a stored beneficiary email — module 10's legacy plan rows
 *  carry the address plaintext in params_json; estate.enroll rewrites it to
 *  this mask (doc 14: never plaintext at rest — the full address lives only
 *  in the KMS envelope from then on). "jane@example.com" → "j•••@example.com". */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

export function beneficiaryHashFor(email: string, salt: string): string {
  return keccak256(concat([toUtf8Bytes(normalizeBeneficiaryEmail(email)), getBytes(salt)]));
}

// ---------------------------------------------------------------------------
// Claim token (PROPOSED mechanics per doc 14: single-use, 7-day expiry, hash
// stored). The token travels ONLY in the email link; the DB stores sha256.
// ---------------------------------------------------------------------------
export const CLAIM_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function mintClaimToken(): { token: string; tokenHash: string } {
  const token = hexlify(randomBytes(32)).slice(2); // 64 hex chars, URL-safe
  return { token, tokenHash: claimTokenHash(token) };
}

export function claimTokenHash(token: string): string {
  return sha256(toUtf8Bytes(token));
}

// ---------------------------------------------------------------------------
// Demo scaling (TS-9.5 — honesty is a spec requirement): substitution happens
// AT ENROLLMENT TIME; the contract schema never changes.
// ---------------------------------------------------------------------------
export function resolveInactivitySecs(
  inactivityDays: number,
  demoMode: boolean,
  demoInactivitySecs: number,
): { inactivitySecs: number; demoScaled: boolean } {
  return demoMode
    ? { inactivitySecs: demoInactivitySecs, demoScaled: true }
    : { inactivitySecs: inactivityDays * 86_400, demoScaled: false };
}

// ---------------------------------------------------------------------------
// Estate status wire view (estate.status → C8 + S5)
// ---------------------------------------------------------------------------
export const ESTATE_STATUS_NAMES = [
  "none",
  "enrolled",
  "countdown",
  "claimable",
  "claimed",
  "cancelled",
] as const;
export type EstateStatusName = (typeof ESTATE_STATUS_NAMES)[number];

export function estateStatusName(status: number): EstateStatusName {
  return ESTATE_STATUS_NAMES[status] ?? "none";
}

/** Plain-JSON view (no tRPC transformer — dates travel as ISO strings). */
export interface EstateStatusView {
  status: EstateStatusName;
  /** ISO — Estate.lastCheckIn on Arbitrum (the heartbeat truth). */
  lastCheckIn: string | null;
  /** ISO — when the inactivity deadline would fire (lastCheckIn + inactivitySecs). */
  deadlineAt: string | null;
  /** ISO — when the claim opens (only while countdown/claimable). */
  claimReadyAt: string | null;
  inactivitySecs: number;
  /** "(demo: minutes)" labeling — TS-9.5 honesty. */
  demoScaled: boolean;
  /** ISO — when the escrow tuple set was last refreshed. */
  coverageRefreshedAt: string | null;
}

// ---------------------------------------------------------------------------
// Claim progress + estate summary shapes (keeper writes; S6/email read)
// ---------------------------------------------------------------------------
export const estateAssetSchema = z.object({
  /** Token contract address, or "native". */
  token: z.string(),
  symbol: z.string().optional(),
  amountHuman: z.string().optional(),
  usd: z.number().optional(),
});
export type EstateAsset = z.infer<typeof estateAssetSchema>;

export const estateSummarySchema = z.object({
  totalUsd: z.number(),
  assetCount: z.number().int().min(0),
  /** Always ≤ 5 — estate coverage copy says "5 sources" (G3/G12). */
  sourceCount: z.number().int().min(0),
  perChain: z.array(
    z.object({
      chainId: z.number().int(),
      network: z.string(),
      usd: z.number(),
      assets: z.array(estateAssetSchema),
    }),
  ),
});
export type EstateSummary = z.infer<typeof estateSummarySchema>;

export const CLAIM_CHAIN_STATES = [
  "pending",
  "delegated",
  "registered",
  "claimed",
  "stale-tuple",
  "failed",
  "skipped",
] as const;
export type ClaimChainState = (typeof CLAIM_CHAIN_STATES)[number];

/** payload of one estate.claim_progress event (keeper → S6 poll). */
export const claimChainProgressSchema = z.object({
  chainId: z.number().int(),
  network: z.string(),
  state: z.enum(CLAIM_CHAIN_STATES),
  detail: z.string().optional(),
  txHash: z.string().optional(),
  assets: z.array(estateAssetSchema).optional(),
});
export type ClaimChainProgress = z.infer<typeof claimChainProgressSchema>;

export function isEstateChainId(id: number): id is EstateChainId {
  return (ESTATE_CHAIN_IDS as readonly number[]).includes(id);
}
