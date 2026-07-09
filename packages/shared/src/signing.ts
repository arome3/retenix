import { sha256, toUtf8Bytes } from "ethers";
import { z } from "zod";

/**
 * Signed-envelope convention for `signedProcedure` routes (doc 00 §tRPC).
 *
 * Every mutating route's input is `{ payload, sig }`. The user's EOA signs
 * (personal_sign) the exact string produced by `buildSignedMessage` over
 * `{ route, inputHash, nonce, expiry }`; the server verifies it with
 * `ethers.verifyMessage`, rejects reused nonces, and rejects expiry > 5 min.
 * Client and server MUST both use the helpers below so the signed bytes
 * can never drift.
 */
export const sigEnvelopeSchema = z.object({
  signature: z.string().min(1),
  // client convention: Date.now() — strictly increasing per user
  nonce: z.number().int().nonnegative(),
  // unix seconds; server rejects if already expired or > 5 min out
  expiry: z.number().int(),
});

export type SigEnvelope = z.infer<typeof sigEnvelopeSchema>;

export const withSig = <T extends z.ZodType>(payload: T) =>
  z.object({ payload, sig: sigEnvelopeSchema });

// Deterministic JSON: objects serialized with recursively sorted keys,
// undefined properties dropped — the canonical preimage for inputHash.
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
};

export const computeInputHash = (payload: unknown): string =>
  sha256(toUtf8Bytes(canonicalJson(payload)));

// Fixed key order by construction — the only place the message is built.
export const buildSignedMessage = (p: {
  route: string;
  inputHash: string;
  nonce: number;
  expiry: number;
}): string =>
  JSON.stringify({
    route: p.route,
    inputHash: p.inputHash,
    nonce: p.nonce,
    expiry: p.expiry,
  });
