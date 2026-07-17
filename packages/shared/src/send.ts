/*
 * Send / withdraw contract (doc 15) — event types, canonical copy, and the wire
 * schemas of the two-phase `send.execute` payload (the sweep.ts discipline:
 * client and server import the SAME schemas so the signed bytes can never
 * drift from what the server validates).
 *
 * Shared is a leaf package: chain ids and asset types appear here as plain
 * strings/numbers; the authoritative derivations (networksForAsset,
 * primaryTokenFor) live in @retenix/ua and the send router composes the two.
 *
 * PROPOSED (spec-silent, flagged in HANDOFF): SEND_MIN_USD / SEND_MAX_USD
 * bounds, the invite copy constant reuse in UI, and the withdraw receipt
 * wording below.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Bounds (PROPOSED — doc 15 fixes no amount bounds; DoD exercises $2)
// ---------------------------------------------------------------------------

/** Below this, fees dominate the transfer — refuse honestly at the form. */
export const SEND_MIN_USD = 1;

/** v1 ceiling per send (hackathon posture; product review at W4). */
export const SEND_MAX_USD = 10_000;

// ---------------------------------------------------------------------------
// Event types (events.type strings — doc 15 set)
// ---------------------------------------------------------------------------

export const SEND_EVENTS = {
  /** Phase-1 forensic record: the server-resolved target the user authorized. */
  authorized: "send.authorized",
  /** Sender-side receipt — exactly one per execution. */
  receipt: "send.receipt",
  /** Recipient-side system receipt (registered-email sends only). */
  received: "send.received",
  /** Unregistered-email invite audit row — never a feed row, never moves funds. */
  invited: "send.invited",
} as const;

// ---------------------------------------------------------------------------
// Canonical copy (doc 15 verbatim)
// ---------------------------------------------------------------------------

/** The unregistered-email response the sender sees (doc 15, verbatim). */
export const SEND_INVITE_COPY =
  "They don't have Retenix yet — we've invited them. Nothing was sent.";

// ---------------------------------------------------------------------------
// Recipient kinds + wire schemas (signed via lib/sign.ts)
// ---------------------------------------------------------------------------

export const SEND_TO_KINDS = ["email", "ens", "address"] as const;
export type SendToKind = (typeof SEND_TO_KINDS)[number];

export const sendToSchema = z.object({
  kind: z.enum(SEND_TO_KINDS),
  value: z.string().trim().min(1).max(320),
});
export type SendTo = z.infer<typeof sendToSchema>;

/** Phase 1 — "authorize": the user's intent. The server re-resolves the
 *  recipient itself at execute time (doc 15: the email→address mapping cannot
 *  be swapped client-side) and pins the target it resolved. `asset`+`chainId`
 *  travel ONLY on withdraws (kind "address"); plain sends are USDC, settled on
 *  the doc-15 PROPOSED default network. `senderEmail` is the sender
 *  self-identifying for the recipient's receipt — the server verifies its hash
 *  against the session user's email_hash and stores only the masked form. */
export const sendAuthorizePayloadSchema = z.object({
  phase: z.literal("authorize"),
  to: sendToSchema,
  amountUsd: z.number().positive().min(SEND_MIN_USD).max(SEND_MAX_USD),
  /** Withdraw only: a primary-asset type ("eth"|"usdt"|"usdc"|"bnb"|"sol"). */
  asset: z.string().min(1).max(16).optional(),
  /** Withdraw only: the destination network the user explicitly chose. */
  chainId: z.number().int().positive().optional(),
  senderEmail: z.string().email().max(320).optional(),
});

export const sendLegOutcomes = ["finished", "refunded", "failed", "timeout"] as const;

/** Fee totals as parseFeeTotals returns them (plain USD numbers) — restated
 *  from sweep.ts's feeTotalsSchema shape to keep this module self-contained. */
export const sendFeeTotalsSchema = z.object({
  gas: z.number(),
  service: z.number(),
  lp: z.number(),
  total: z.number(),
});

/** Phase 2 — "report": what the client saw. All claims: the server re-polls
 *  the transactionId itself and matches owner/asset/destination against the
 *  AUTHORIZED row before any receipt exists. */
export const sendReportPayloadSchema = z.object({
  phase: z.literal("report"),
  executionId: z.uuid(),
  transactionId: z.string().min(1).max(256).optional(),
  clientOutcome: z.enum(sendLegOutcomes),
  /** Client-side parseFeeTotals of the executed quote (doc 03 OQ5 posture). */
  feesQuoted: sendFeeTotalsSchema.optional(),
  error: z.string().max(500).optional(),
});

export const sendExecutePayloadSchema = z.discriminatedUnion("phase", [
  sendAuthorizePayloadSchema,
  sendReportPayloadSchema,
]);
export type SendExecutePayload = z.infer<typeof sendExecutePayloadSchema>;
export type SendAuthorizePayload = z.infer<typeof sendAuthorizePayloadSchema>;
export type SendReportPayload = z.infer<typeof sendReportPayloadSchema>;

// ---------------------------------------------------------------------------
// The authorized target (send.authorized payload_json shape) — what the
// server resolved and the ONLY thing the runner may transfer against.
// ---------------------------------------------------------------------------

export interface SendAuthorizedTarget {
  /** Receiver address exactly as the server resolved it. */
  address: string;
  /** Token the transfer moves. `decimals` is the ON-CHAIN (realDecimals)
   *  precision — the SDK's IToken.decimals is 18-dp normalized and must
   *  never be stored here (pinned in @retenix/ua constants.test.ts). */
  token: { chainId: number; address: string; decimals: number; symbol: string };
  /** Exact token units to transfer, human decimal string — pinned server-side. */
  amountUnits: string;
  /** The USD figure the user confirmed (display; ≈ for non-stables). */
  amountUsd: number;
  /** What the receipt calls the recipient (masked email / ENS name / 0x…). */
  display: string;
  /** True when this authorize came through the withdraw flow (asset+network). */
  withdraw: boolean;
  /** Recipient user id for registered-email sends (drives send.received). */
  recipientUserId?: string;
  /** Masked sender email for the recipient's receipt (never raw). */
  senderDisplay?: string;
}

export interface SendAuthorizedRecord {
  executionId: string;
  target: SendAuthorizedTarget;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Receipt payloads (kill.ts's multi-consumer discipline — these shapes serve
// THREE consumers at once and every field is load-bearing):
//   1. the feed (payload.receipt is the display sentence; module 11 renders
//      it verbatim and skips rows without one),
//   2. the portfolio ledger (payload.ledgerFill on sol/eth WITHDRAWS only —
//      see portfolio-fills.ts withdrawFillFromEvent; omit everywhere else),
//   3. send.execute's own idempotency reads (executionId/transactionId).
// ---------------------------------------------------------------------------

export type SendOutcome = "finished" | "refunded" | "failed" | "unverified";

export interface SendReceiptPayload {
  executionId: string;
  /** Display-ready sentence (receipts.ts template output, byte-verbatim). */
  receipt: string;
  outcome: SendOutcome;
  usd: number;
  /** What the sentence calls the recipient (masked email / ENS / 0x1234…abcd). */
  toDisplay: string;
  withdraw: boolean;
  /** Receipt provenance context (withdraws name their network). */
  network?: string;
  symbol?: string;
  transactionId?: string;
  /** false = server could not confirm the leg against Particle (honesty flag). */
  serverVerified: boolean;
  fees?: { gas: number; service: number; lp: number; total: number };
  feeSource?: "settled" | "quoted" | "none";
  /** sol/eth withdraws only — the portfolio-ledger decrement (see header). */
  ledgerFill?: { assetId: string; qty: number | null; usd: number };
}

export interface SendReceivedPayload {
  /** Sender's executionId — pairs the two sides for support/forensics. */
  executionId: string;
  receipt: string;
  usd: number;
  /** MASKED sender email, verified against the sender's email_hash. */
  fromDisplay: string;
  transactionId?: string;
}

// ---------------------------------------------------------------------------
// send.resolve wire types (form-time preview; re-resolved at execute)
// ---------------------------------------------------------------------------

export type SendResolveStatus =
  | "registered" // email belongs to a Retenix account
  | "unregistered" // valid email, no account — the invite path
  | "resolved" // ENS resolved / address checksum-valid
  | "not-found" // ENS name did not resolve ("name not found")
  | "invalid"; // malformed input for the detected kind

export interface SendResolveResult {
  status: SendResolveStatus;
  /** Resolved receiver (ENS/address kinds; never exposed for email lookups). */
  address?: string;
  /** What the confirm sentence will call the recipient. */
  display: string;
}
