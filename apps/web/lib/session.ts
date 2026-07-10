/*
 * The Retenix session (doc 02).
 *
 * A DID token proves who the user is exactly once, at auth.magicCallback. From
 * then on the claim lives in an HMAC-signed cookie: HS256 over SESSION_SECRET,
 * httpOnly, Secure, SameSite=Lax, seven-day sliding expiry. Doc 02 says
 * "iron-session or equivalent"; HS256 is that HMAC, and jose is already resolved
 * in the tree. Nothing in the payload is secret — an EOA is public and an issuer
 * is a DID — so the requirement is integrity, not confidentiality.
 *
 * region is a PROPOSED addition to the documented {userId, eoa, issuer} payload.
 * It exists so the proxy can route a region-less session to the gate without a
 * database round trip. The database stays authoritative: the app shell and the
 * gate procedures re-read users.region, and a forged cookie buys nothing.
 */
import { SignJWT, jwtVerify } from "jose";
import { env } from "@/env";
import { serializeCookie } from "./cookies";

export const SESSION_COOKIE = "retenix_session";

/*
 * Presence-only routing hint for the proxy, which runs where neither the secret
 * nor the database is reachable. Never an authorization decision.
 */
export const GATE_COOKIE = "retenix_gate";

const ALG = "HS256";
export const SESSION_TTL_SECS = 7 * 24 * 60 * 60;
/** Re-issue once a session is older than this, giving the 7 days a sliding window. */
export const SESSION_REFRESH_AFTER_SECS = 24 * 60 * 60;

export type SessionPayload = {
  userId: string;
  eoa: string;
  issuer: string;
  /** ISO 3166-1 alpha-2, or "" until the eligibility gate runs (doc 04). */
  region: string;
};

export type VerifiedSession = SessionPayload & { issuedAt: number };

let cachedKey: Uint8Array | null = null;

/*
 * SESSION_SECRET is a free-form string, but HS256 needs 256 bits of key. Hashing
 * it derives a full-length key from any secret without weakening a strong one.
 */
async function sessionKey(): Promise<Uint8Array> {
  if (!cachedKey) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(env.SESSION_SECRET),
    );
    cachedKey = new Uint8Array(digest);
  }
  return cachedKey;
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return await new SignJWT({
    eoa: payload.eoa,
    issuer: payload.issuer,
    region: payload.region,
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECS}s`)
    .sign(await sessionKey());
}

/** Returns null for anything unusable: absent, forged, tampered, or expired. */
export async function verifySession(
  token: string | undefined,
): Promise<VerifiedSession | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, await sessionKey(), {
      algorithms: [ALG],
    });
    const { sub, iat, eoa, issuer, region } = payload as Record<string, unknown>;
    if (
      typeof sub !== "string" ||
      typeof iat !== "number" ||
      typeof eoa !== "string" ||
      typeof issuer !== "string" ||
      typeof region !== "string"
    ) {
      return null;
    }
    return { userId: sub, eoa, issuer, region, issuedAt: iat };
  } catch {
    return null;
  }
}

export function shouldRefresh(issuedAt: number, now = Date.now()): boolean {
  return Math.floor(now / 1000) - issuedAt > SESSION_REFRESH_AFTER_SECS;
}

/** Set-Cookie values for an established session. The gate hint tracks region. */
export function sessionSetCookies(token: string, region: string): string[] {
  return [
    serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_SECS }),
    region
      ? serializeCookie(GATE_COOKIE, "1", { maxAge: SESSION_TTL_SECS })
      : serializeCookie(GATE_COOKIE, "", { maxAge: 0 }),
  ];
}

/** Set-Cookie values that end the session. */
export function clearedSetCookies(): string[] {
  return [
    serializeCookie(SESSION_COOKIE, "", { maxAge: 0 }),
    serializeCookie(GATE_COOKIE, "", { maxAge: 0 }),
  ];
}

/** Test seam: drops the derived key so a restubbed SESSION_SECRET takes effect. */
export function __resetSessionKeyForTests(): void {
  cachedKey = null;
}
