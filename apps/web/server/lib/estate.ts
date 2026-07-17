// Estate server helpers (doc 14) — escrow provider resolution (KMS/dev), the
// beneficiary-secret envelope, estate state reads with the DB cache, and
// claim-token verification. The web side only ever ENCRYPTS estate secrets;
// decryption lives in the worker keeper path (TS-14.3's boundary).
import { KMSClient, DecryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import {
  ESTATE_EVENTS,
  claimTokenHash,
  estateStatusName,
  estateSummarySchema,
  type EstateStatusView,
  type EstateSummary,
} from "@retenix/shared";
import {
  devEscrowProvider,
  encryptEnvelope,
  escrowEncryptionContext,
  toBuffer,
  type EscrowKeyProvider,
} from "@retenix/shared/escrow";
import { estates, events, type Db } from "@retenix/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { env, isProductionRuntime } from "@/env";
import type { PlanRelay } from "./relay-factory";

// ---------------------------------------------------------------------------
// Escrow provider — the module-08 dev/KMS duality: ESCROW_DEV_SECRET selects
// the local provider and is FORBIDDEN in production; otherwise AWS KMS with
// the canonical escrow key (every use lands in CloudTrail).
// ---------------------------------------------------------------------------
export function getEscrowProvider(): EscrowKeyProvider {
  if (env.ESCROW_DEV_SECRET) {
    if (isProductionRuntime) {
      throw new Error(
        "[estate] ESCROW_DEV_SECRET is set in production — the escrow key must be KMS",
      );
    }
    return devEscrowProvider(env.ESCROW_DEV_SECRET);
  }
  const client = new KMSClient({ region: env.AWS_REGION });
  return {
    kind: "kms",
    async generateDataKey(context) {
      const out = await client.send(
        new GenerateDataKeyCommand({
          KeyId: env.KMS_ESCROW_KEY_ID,
          KeySpec: "AES_256",
          EncryptionContext: context,
        }),
      );
      if (!out.Plaintext || !out.CiphertextBlob) {
        throw new Error("[estate] KMS GenerateDataKey returned no key material");
      }
      return {
        plaintextKey: toBuffer(out.Plaintext),
        encryptedKey: toBuffer(out.CiphertextBlob),
      };
    },
    async decryptDataKey(encryptedKey, context) {
      const out = await client.send(
        new DecryptCommand({
          KeyId: env.KMS_ESCROW_KEY_ID,
          CiphertextBlob: encryptedKey,
          EncryptionContext: context,
        }),
      );
      if (!out.Plaintext) throw new Error("[estate] KMS Decrypt returned no key material");
      return toBuffer(out.Plaintext);
    },
  };
}

// ---------------------------------------------------------------------------
// Beneficiary secret — email + salt (+ optional owner display name), one
// envelope in estates.beneficiary_email_enc. Only the keccak hash goes
// onchain (TS-12.2); plaintext exists in memory during enroll and in the
// keeper's claim path, nowhere else.
// ---------------------------------------------------------------------------
export const beneficiarySecretSchema = z.object({
  email: z.string(),
  salt: z.string(),
  ownerName: z.string().optional(),
});
export type BeneficiarySecret = z.infer<typeof beneficiarySecretSchema>;

export async function encryptBeneficiarySecret(
  provider: EscrowKeyProvider,
  owner: string,
  secret: BeneficiarySecret,
): Promise<string> {
  return encryptEnvelope(
    provider,
    { owner, purpose: "estate-beneficiary" },
    JSON.stringify(secret),
  );
}

export async function encryptTupleSet(
  provider: EscrowKeyProvider,
  owner: string,
  tuples: unknown[],
): Promise<string> {
  return encryptEnvelope(provider, { owner, purpose: "estate-tuples" }, JSON.stringify(tuples));
}

export { escrowEncryptionContext };

// ---------------------------------------------------------------------------
// Tuple ceremony targets — the deployed RetenixClaim per chain (env is the
// runtime record) and the owner's live account nonce per chain (server-read
// over the canonical RPC_URL_*; the browser never reads RPC endpoints).
// Injectable reader — the relay-factory test-seam precedent.
// ---------------------------------------------------------------------------
export function claimDelegateFor(chainId: number): string {
  switch (chainId) {
    case 1:
      return env.CLAIM_DELEGATE_ADDRESS_ETHEREUM;
    case 8453:
      return env.CLAIM_DELEGATE_ADDRESS_BASE;
    case 42161:
      return env.CLAIM_DELEGATE_ADDRESS_ARBITRUM;
    case 56:
      return env.CLAIM_DELEGATE_ADDRESS_BSC;
    case 196:
      return env.CLAIM_DELEGATE_ADDRESS_XLAYER;
    default:
      throw new Error(`[estate] no claim target recorded for ${chainId}`);
  }
}

function rpcUrlFor(chainId: number): string {
  switch (chainId) {
    case 1:
      return env.RPC_URL_ETHEREUM;
    case 8453:
      return env.RPC_URL_BASE;
    case 42161:
      return env.RPC_URL_ARBITRUM;
    case 56:
      return env.RPC_URL_BSC;
    case 196:
      return env.RPC_URL_XLAYER;
    default:
      throw new Error(`[estate] no RPC endpoint recorded for ${chainId}`);
  }
}

export interface EstateChainReader {
  /** eth_getTransactionCount(owner, "latest") — the tuple nonce binding. */
  accountNonce(chainId: number, owner: string): Promise<number>;
}

async function jsonRpcNonce(chainId: number, owner: string): Promise<number> {
  const res = await fetch(rpcUrlFor(chainId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionCount",
      params: [owner, "latest"],
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`[estate] nonce read failed on ${chainId}: ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (typeof body.result !== "string") {
    throw new Error(
      `[estate] nonce read failed on ${chainId}: ${body.error?.message ?? "no result"}`,
    );
  }
  return Number(BigInt(body.result));
}

let chainReaderFactory: () => EstateChainReader = () => ({ accountNonce: jsonRpcNonce });
export function getEstateChainReader(): EstateChainReader {
  return chainReaderFactory();
}
export function setEstateChainReaderFactory(f: () => EstateChainReader): void {
  chainReaderFactory = f;
}
export function resetEstateChainReaderFactory(): void {
  chainReaderFactory = () => ({ accountNonce: jsonRpcNonce });
}

// ---------------------------------------------------------------------------
// Estate state — chain first, DB cache as the fallback (summary.ts's
// serve-stale posture: an RPC blip must not blank C8 mid-countdown).
// ---------------------------------------------------------------------------
const cacheSchema = z.object({
  status: z.string(),
  lastCheckIn: z.string().nullable(),
  deadlineAt: z.string().nullable(),
  claimReadyAt: z.string().nullable(),
  inactivitySecs: z.number(),
  demoScaled: z.boolean(),
  updatedAt: z.string(),
  lastObservedTxAt: z.string().nullish(),
});
export type EstateStateCache = z.infer<typeof cacheSchema>;

function toIso(epochSecs: bigint): string | null {
  return epochSecs === 0n ? null : new Date(Number(epochSecs) * 1000).toISOString();
}

export function viewFromChain(e: {
  inactivitySecs: bigint;
  lastCheckIn: bigint;
  claimReadyAt: bigint;
  status: number;
}, demoScaled: boolean, coverageRefreshedAt: string | null): EstateStatusView {
  const lastCheckIn = toIso(e.lastCheckIn);
  return {
    status: estateStatusName(e.status),
    lastCheckIn,
    deadlineAt:
      lastCheckIn === null
        ? null
        : new Date(Number(e.lastCheckIn + e.inactivitySecs) * 1000).toISOString(),
    claimReadyAt: toIso(e.claimReadyAt),
    inactivitySecs: Number(e.inactivitySecs),
    demoScaled,
    coverageRefreshedAt,
  };
}

/** Read the estate view — chain, falling back to the cached copy; refreshes
 *  the cache on every successful read (the worker heartbeat does the same,
 *  so C8's poll always has a recent copy to fall back on). */
export async function readEstateView(
  relay: PlanRelay,
  db: Db,
  userId: string,
  owner: string,
): Promise<EstateStatusView | null> {
  const [row] = await db
    .select({
      cache: estates.contractStateCache,
      refreshedAt: estates.refreshedAt,
    })
    .from(estates)
    .where(eq(estates.userId, userId))
    .limit(1);
  if (!row) return null; // never enrolled

  const cached = cacheSchema.nullable().catch(null).parse(row.cache);
  const refreshedIso = row.refreshedAt ? row.refreshedAt.toISOString() : null;
  try {
    const chain = await relay.estateOf(owner);
    const view = viewFromChain(chain, cached?.demoScaled ?? false, refreshedIso);
    await db
      .update(estates)
      .set({
        contractStateCache: {
          status: view.status,
          lastCheckIn: view.lastCheckIn,
          deadlineAt: view.deadlineAt,
          claimReadyAt: view.claimReadyAt,
          inactivitySecs: view.inactivitySecs,
          demoScaled: view.demoScaled,
          updatedAt: new Date().toISOString(),
          lastObservedTxAt: cached?.lastObservedTxAt ?? null,
        } satisfies EstateStateCache,
      })
      .where(eq(estates.userId, userId));
    return view;
  } catch {
    if (!cached) return null;
    // serve the last-known state with its own timestamps — C8 stays honest
    return {
      status: cached.status as EstateStatusView["status"],
      lastCheckIn: cached.lastCheckIn,
      deadlineAt: cached.deadlineAt,
      claimReadyAt: cached.claimReadyAt,
      inactivitySecs: cached.inactivitySecs,
      demoScaled: cached.demoScaled,
      coverageRefreshedAt: refreshedIso,
    };
  }
}

// ---------------------------------------------------------------------------
// Claim token store — events rows are the ledger (append-only audit, the
// sweep.authorized precedent): estate.claim_email_sent carries
// {tokenHash, expiresAt, summary, ownerName?}; estate.claim_started marks the
// single use. Verification never sees a raw token in the DB.
// ---------------------------------------------------------------------------
const claimEmailPayloadSchema = z.object({
  tokenHash: z.string(),
  expiresAt: z.string(),
  summary: estateSummarySchema.optional(),
  ownerName: z.string().nullish(),
  /** sha256(lowercase(beneficiary email)) — users.email_hash format. The
   *  keeper writes it from the DECRYPTED secret, so claimStart can require
   *  the heir's Magic session to be on the named email without the web ever
   *  decrypting (the keccak‖salt revealed-match stays keeper-side). */
  beneficiaryEmailHash: z.string().optional(),
});

export interface ClaimTokenRecord {
  ownerUserId: string;
  tokenHash: string;
  expiresAt: Date;
  summary: EstateSummary | null;
  ownerName: string | null;
  beneficiaryEmailHash: string | null;
  used: boolean;
}

/** Find the claim-token record matching a presented token (hash lookup across
 *  recent claim emails), or null. Single-use state comes from the presence of
 *  an estate.claim_started row citing the same tokenHash. */
export async function findClaimToken(db: Db, token: string): Promise<ClaimTokenRecord | null> {
  const hash = claimTokenHash(token);
  const sent = await db
    .select({
      userId: events.userId,
      payload: events.payloadJson,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(eq(events.type, ESTATE_EVENTS.claimEmailSent))
    .orderBy(desc(events.createdAt))
    .limit(200);
  for (const row of sent) {
    const parsed = claimEmailPayloadSchema.safeParse(row.payload);
    if (!parsed.success || parsed.data.tokenHash !== hash || !row.userId) continue;
    // single-use is per token, not per estate — a re-sent email mints a new hash
    const used = await tokenUsed(db, row.userId, hash);
    return {
      ownerUserId: row.userId,
      tokenHash: hash,
      expiresAt: new Date(parsed.data.expiresAt),
      summary: parsed.data.summary ?? null,
      ownerName: parsed.data.ownerName ?? null,
      beneficiaryEmailHash: parsed.data.beneficiaryEmailHash ?? null,
      used,
    };
  }
  return null;
}

async function tokenUsed(db: Db, ownerUserId: string, tokenHash: string): Promise<boolean> {
  const rows = await db
    .select({ payload: events.payloadJson })
    .from(events)
    .where(and(eq(events.userId, ownerUserId), eq(events.type, ESTATE_EVENTS.claimStarted)))
    .limit(50);
  return rows.some(
    (r) => (r.payload as { tokenHash?: string } | null)?.tokenHash === tokenHash,
  );
}
