// KMS envelope encryption for estate secrets (doc 14, TS-14.3) — the ONE
// implementation both apps use: apps/web ENCRYPTS at estate.enroll (tuples +
// beneficiary email/salt into estates.tuples_enc / beneficiary_email_enc);
// apps/worker DECRYPTS in the keeper path only. Ciphertext at rest, always.
//
// Scheme: per write, a FRESH 256-bit data key (DEK) from the provider →
// AES-256-GCM locally with a random 12-byte IV and an AAD that binds the
// blob to its owner + purpose → store {v, kind, encKey, iv, tag, ct}. The
// provider's EncryptionContext carries the same binding, so KMS refuses to
// unwrap a blob under a swapped owner AND every CloudTrail line names the
// owner (TS-14.3's audit requirement).
//
// This module deliberately lives OUTSIDE the package barrel (subpath export
// "@retenix/shared/escrow") — it imports node:crypto, which must never reach
// a client bundle. The provider interface is structural so this package gains
// no AWS dependency; each app wraps its own KMSClient in a ~10-line adapter
// (the worker's KmsClientLike precedent, apps/worker/src/kms.ts).
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { z } from "zod";

/** Binding for the AAD + KMS EncryptionContext. `owner` is the EOA address. */
export interface EscrowContext {
  owner: string;
  purpose: "estate-tuples" | "estate-beneficiary";
}

/** Structural key provider. KMS adapters wrap GenerateDataKeyCommand /
 *  DecryptCommand (convert AWS's Uint8Arrays with toBuffer below); the dev
 *  provider derives keys from a local secret. Buffer-native on purpose —
 *  node's crypto typings and the TS 5.x Uint8Array generics don't mix. */
export interface EscrowKeyProvider {
  readonly kind: "kms" | "dev";
  generateDataKey(
    context: Record<string, string>,
  ): Promise<{ plaintextKey: Buffer; encryptedKey: Buffer }>;
  decryptDataKey(
    encryptedKey: Buffer,
    context: Record<string, string>,
  ): Promise<Buffer>;
}

/** Generic-safe Uint8Array → Buffer copy (for KMS adapter boundaries). */
export function toBuffer(bytes: Uint8Array): Buffer {
  const copy = Buffer.alloc(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

const envelopeSchema = z.object({
  v: z.literal(1),
  kind: z.enum(["kms", "dev"]),
  encKey: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  ct: z.string(),
});
export type EscrowEnvelope = z.infer<typeof envelopeSchema>;

function aad(ctx: EscrowContext): Buffer {
  return Buffer.from(`retenix-escrow:v1:${ctx.purpose}:${ctx.owner.toLowerCase()}`, "utf8");
}

/** The KMS EncryptionContext mirror of the AAD binding (string map). */
export function escrowEncryptionContext(ctx: EscrowContext): Record<string, string> {
  return { app: "retenix", purpose: ctx.purpose, owner: ctx.owner.toLowerCase() };
}

export async function encryptEnvelope(
  provider: EscrowKeyProvider,
  ctx: EscrowContext,
  plaintext: Uint8Array | string,
): Promise<string> {
  const { plaintextKey, encryptedKey } = await provider.generateDataKey(
    escrowEncryptionContext(ctx),
  );
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", plaintextKey, iv);
    cipher.setAAD(aad(ctx));
    const input =
      typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : toBuffer(plaintext);
    const ct = Buffer.concat([cipher.update(input), cipher.final()]);
    const blob: EscrowEnvelope = {
      v: 1,
      kind: provider.kind,
      encKey: encryptedKey.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
    };
    return JSON.stringify(blob);
  } finally {
    // the DEK never outlives the write
    plaintextKey.fill(0);
  }
}

/** Parse without decrypting — callers pick the provider by `kind` (and the
 *  worker refuses `dev` blobs in production). */
export function parseEnvelope(blob: string): EscrowEnvelope {
  return envelopeSchema.parse(JSON.parse(blob));
}

export async function decryptEnvelope(
  provider: EscrowKeyProvider,
  ctx: EscrowContext,
  blob: string,
): Promise<Buffer> {
  const env = parseEnvelope(blob);
  if (env.kind !== provider.kind) {
    throw new Error(
      `escrow envelope kind "${env.kind}" does not match the ${provider.kind} provider`,
    );
  }
  const key = await provider.decryptDataKey(
    Buffer.from(env.encKey, "base64"),
    escrowEncryptionContext(ctx),
  );
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
    decipher.setAAD(aad(ctx));
    decipher.setAuthTag(Buffer.from(env.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]);
  } finally {
    key.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Dev provider — NO AWS. Key material derives from a local secret; the DEK is
// wrapped locally so the envelope format is identical to the KMS path. Fenced
// out of production by the callers (getEscrowProvider adapters throw when
// NODE_ENV === "production", mirroring getAgentSigner's dev fence).
// ---------------------------------------------------------------------------

export function devEscrowProvider(secret: string): EscrowKeyProvider {
  if (!secret || secret.length < 8) {
    throw new Error("devEscrowProvider needs a non-trivial secret");
  }
  const kek = Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("retenix-escrow-v1"), Buffer.from("kek"), 32),
  );
  return {
    kind: "dev",
    generateDataKey(context) {
      const dek = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", kek, iv);
      cipher.setAAD(Buffer.from(JSON.stringify(context), "utf8"));
      const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
      const encryptedKey = Buffer.concat([iv, cipher.getAuthTag(), wrapped]);
      return Promise.resolve({ plaintextKey: dek, encryptedKey });
    },
    decryptDataKey(encryptedKey, context) {
      const iv = encryptedKey.subarray(0, 12);
      const tag = encryptedKey.subarray(12, 28);
      const wrapped = encryptedKey.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", kek, iv);
      decipher.setAAD(Buffer.from(JSON.stringify(context), "utf8"));
      decipher.setAuthTag(tag);
      return Promise.resolve(Buffer.concat([decipher.update(wrapped), decipher.final()]));
    },
  };
}
