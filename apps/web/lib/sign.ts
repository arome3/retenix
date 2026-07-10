import {
  buildSignedMessage,
  computeInputHash,
  type SigEnvelope,
} from "@retenix/shared";
import { magic } from "./magic";

/**
 * The client half of `signedProcedure` (doc 00). Every mutating route takes a
 * `{ payload, sig }` envelope; the server rebuilds the exact preimage with the
 * same `@retenix/shared` helpers and recovers the signer with `ethers.verifyMessage`.
 * Neither side may re-derive the message — that is why both import from there.
 *
 * Signing is plain `personal_sign`, never typed data (G5), and it is headless:
 * one Retenix confirmation can drive N underlying signatures without N popups.
 */

/** The server rejects anything beyond 5 minutes; leave headroom for slow hops. */
const EXPIRY_WINDOW_SECS = 240;

/**
 * The raw provider call, exactly as doc 03 and doc 14 use it. Not a wrapper with
 * opinions: `message` goes to the provider untouched.
 */
export async function personalSign(
  message: string,
  eoa: string,
): Promise<string> {
  return await magic.rpcProvider.request<string>({
    method: "personal_sign",
    params: [message, eoa],
  });
}

export async function signEnvelope<T>(
  route: string,
  payload: T,
  eoa: string,
): Promise<{ payload: T; sig: SigEnvelope }> {
  // Client convention (doc 00): nonce is Date.now(), strictly increasing per user.
  const nonce = Date.now();
  const expiry = Math.floor(Date.now() / 1000) + EXPIRY_WINDOW_SECS;
  const message = buildSignedMessage({
    route,
    inputHash: computeInputHash(payload),
    nonce,
    expiry,
  });
  const signature = await personalSign(message, eoa);
  return { payload, sig: { signature, nonce, expiry } };
}
