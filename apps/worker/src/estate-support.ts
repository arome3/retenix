// Estate keeper/heartbeat support (doc 14): the worker-side escrow provider
// (the ONLY place estate ciphertexts are decrypted — TS-14.3), the Arbitrum
// estate-contract surface, the claim-delegate map, enrolled-estate queries,
// and the claim email. Everything network-shaped is injectable; the crons in
// heartbeat.ts / keeper.ts stay orchestration-only.
import { KMSClient, DecryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import {
  ESTATE_EVENTS,
  RETENIX_POLICY_ABI,
  escrowTupleSchema,
  type EscrowTuple,
  type EstateSummary,
} from "@retenix/shared";
import {
  decryptEnvelope,
  devEscrowProvider,
  toBuffer,
  type EscrowKeyProvider,
} from "@retenix/shared/escrow";
import { estates, events, users, type Db } from "@retenix/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Contract, JsonRpcProvider, NonceManager, type Signer } from "ethers";
import { z } from "zod";

import { env } from "../env";
import { recordEvent, slack } from "./notify";

// ---------------------------------------------------------------------------
// Escrow provider — worker side (decrypt lives HERE and nowhere else).
// Dev/KMS duality mirrors getAgentSigner: ESCROW_DEV_SECRET is dev-only.
// ---------------------------------------------------------------------------
export function getWorkerEscrowProvider(): EscrowKeyProvider {
  if (env.ESCROW_DEV_SECRET) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "ESCROW_DEV_SECRET is dev-only and forbidden in production — the escrow key lives in AWS KMS (doc 14)",
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
        throw new Error("KMS GenerateDataKey returned no key material");
      }
      return { plaintextKey: toBuffer(out.Plaintext), encryptedKey: toBuffer(out.CiphertextBlob) };
    },
    async decryptDataKey(encryptedKey, context) {
      // every call lands in CloudTrail with the owner in the context (TS-14.3)
      const out = await client.send(
        new DecryptCommand({
          KeyId: env.KMS_ESCROW_KEY_ID,
          CiphertextBlob: encryptedKey,
          EncryptionContext: context,
        }),
      );
      if (!out.Plaintext) throw new Error("KMS Decrypt returned no key material");
      return toBuffer(out.Plaintext);
    },
  };
}

const beneficiarySecretSchema = z.object({
  email: z.string(),
  salt: z.string(),
  ownerName: z.string().optional(),
});
export type BeneficiarySecret = z.infer<typeof beneficiarySecretSchema>;

export async function decryptBeneficiarySecret(
  provider: EscrowKeyProvider,
  owner: string,
  blob: string,
): Promise<BeneficiarySecret> {
  const out = await decryptEnvelope(provider, { owner, purpose: "estate-beneficiary" }, blob);
  return beneficiarySecretSchema.parse(JSON.parse(out.toString("utf8")));
}

export async function decryptTupleSet(
  provider: EscrowKeyProvider,
  owner: string,
  blob: string,
): Promise<EscrowTuple[]> {
  const out = await decryptEnvelope(provider, { owner, purpose: "estate-tuples" }, blob);
  return (JSON.parse(out.toString("utf8")) as unknown[]).map((t) => escrowTupleSchema.parse(t));
}

// ---------------------------------------------------------------------------
// Claim delegates (env is the runtime record; docs/deployments.md the ledger)
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
      throw new Error(`no claim delegate for chain ${chainId}`);
  }
}

export function chainRpcUrl(chainId: number): string {
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
      throw new Error(`no RPC endpoint for chain ${chainId}`);
  }
}

// ---------------------------------------------------------------------------
// Arbitrum estate surface (RetenixPolicy) — reads + the three estate writes.
// The relayer/keeper identity is the agent signer (all contract roles are
// the same EOA on the current deployments; role wiring is an ops item in the
// HANDOFF). Injectable for tests.
// ---------------------------------------------------------------------------
export interface EstateChainState {
  beneficiaryHash: string;
  inactivitySecs: bigint;
  lastCheckIn: bigint;
  claimReadyAt: bigint;
  /** estateStatus(owner) — Claimable is a READ state past claimReadyAt. */
  status: number;
}

export interface EstateOnchain {
  estateOf(owner: string): Promise<EstateChainState>;
  checkIn(owner: string): Promise<{ txHash: string }>;
  fireDeadline(owner: string): Promise<{ txHash: string }>;
  markClaimed(owner: string, heir: string): Promise<{ txHash: string }>;
  /** The heir recorded by a prior markClaimed (from the Claimed event log). */
  claimedHeir(owner: string): Promise<string | null>;
}

export class PolicyEstateClient implements EstateOnchain {
  private readonly provider: JsonRpcProvider;
  private readonly reader: Contract;
  private readonly writer: Contract;

  constructor(signer: Signer) {
    this.provider = new JsonRpcProvider(env.RPC_URL_ARBITRUM);
    this.reader = new Contract(env.POLICY_CONTRACT_ADDRESS, RETENIX_POLICY_ABI, this.provider);
    this.writer = new Contract(
      env.POLICY_CONTRACT_ADDRESS,
      RETENIX_POLICY_ABI,
      new NonceManager(signer.connect(this.provider)),
    );
  }

  async estateOf(owner: string): Promise<EstateChainState> {
    const [e, status] = await Promise.all([
      this.reader.estates(owner) as Promise<[string, string, bigint, bigint, bigint, bigint]>,
      this.reader.estateStatus(owner) as Promise<bigint>,
    ]);
    return {
      beneficiaryHash: e[1],
      inactivitySecs: e[2],
      lastCheckIn: e[3],
      claimReadyAt: e[4],
      status: Number(status),
    };
  }

  async checkIn(owner: string): Promise<{ txHash: string }> {
    const tx = await this.writer.checkIn(owner);
    await tx.wait();
    return { txHash: tx.hash as string };
  }

  async fireDeadline(owner: string): Promise<{ txHash: string }> {
    const tx = await this.writer.fireDeadline(owner);
    await tx.wait();
    return { txHash: tx.hash as string };
  }

  async markClaimed(owner: string, heir: string): Promise<{ txHash: string }> {
    const tx = await this.writer.markClaimed(owner, heir);
    await tx.wait();
    return { txHash: tx.hash as string };
  }

  async claimedHeir(owner: string): Promise<string | null> {
    const logs = await this.reader.queryFilter(this.reader.filters.Claimed(owner), -500_000);
    const last = logs.at(-1);
    if (!last || !("args" in last)) return null;
    return (last.args as unknown as { heir: string }).heir;
  }
}

// ---------------------------------------------------------------------------
// Rows + events
// ---------------------------------------------------------------------------
export interface EnrolledEstate {
  userId: string;
  owner: string;
  beneficiaryEmailEnc: string;
  tuplesEnc: string | null;
  contractStateCache: unknown;
}

export async function enrolledEstates(db: Db): Promise<EnrolledEstate[]> {
  const rows = await db
    .select({
      userId: estates.userId,
      owner: users.eoaAddr,
      beneficiaryEmailEnc: estates.beneficiaryEmailEnc,
      tuplesEnc: estates.tuplesEnc,
      contractStateCache: estates.contractStateCache,
    })
    .from(estates)
    .innerJoin(users, eq(users.id, estates.userId));
  return rows;
}

export async function latestEvent(
  db: Db,
  userId: string,
  types: string[],
): Promise<{ type: string; payload: unknown; at: Date } | null> {
  const [row] = await db
    .select({ type: events.type, payload: events.payloadJson, at: events.createdAt })
    .from(events)
    .where(and(eq(events.userId, userId), inArray(events.type, types)))
    .orderBy(desc(events.createdAt))
    .limit(1);
  return row ?? null;
}

export { recordEvent };

// ---------------------------------------------------------------------------
// The claim email (PROPOSED provider: Resend — recorded for doc 17). Plain
// fetch, no SDK. Absent key → the link is logged LOUDLY (console + Slack)
// and the send is reported dishonest-proof: {sent:false, link} so the demo
// proceeds by opening the link directly.
// ---------------------------------------------------------------------------
export interface ClaimEmail {
  to: string;
  link: string;
  ownerName: string | null;
  summary: EstateSummary;
}

export async function sendClaimEmail(mail: ClaimEmail): Promise<{ sent: boolean }> {
  const named = mail.ownerName ? `${mail.ownerName} named you` : "You've been named";
  // S6 register: plain language, one action, zero crypto vocabulary (AC3)
  const subject = mail.ownerName
    ? `${mail.ownerName} left something for you`
    : "Something has been left for you";
  const totalUsd = mail.summary.totalUsd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
  const html = [
    `<p>${named} as a beneficiary.</p>`,
    `<p>An account holding about <strong>${totalUsd}</strong> across ${mail.summary.assetCount} assets is ready for you to claim. It takes one confirmation and a few minutes.</p>`,
    `<p><a href="${mail.link}">Claim what was left for you</a></p>`,
    `<p>This link works once and expires in 7 days. If you weren't expecting this, you can ignore it.</p>`,
  ].join("\n");

  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    console.warn(
      `[keeper] NO EMAIL PROVIDER — claim link for ${mail.to} (open directly): ${mail.link}`,
    );
    await slack(`estate claim email NOT sent (no provider) — link: ${mail.link}`);
    return { sent: false };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [mail.to], subject, html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.warn(`[keeper] claim email failed (${res.status}) — link: ${mail.link}`);
    await slack(`estate claim email FAILED (${res.status} ${detail.slice(0, 200)}) — link: ${mail.link}`);
    return { sent: false };
  }
  return { sent: true };
}

/** Convenience: has this estate already produced a given event? */
export async function hasEvent(
  db: Db,
  userId: string,
  type: string,
): Promise<boolean> {
  return (await latestEvent(db, userId, [type])) !== null;
}

export const ESTATE_EVENT_TYPES = ESTATE_EVENTS;
