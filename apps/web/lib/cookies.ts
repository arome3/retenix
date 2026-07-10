/*
 * Minimal cookie serialize/parse. The app sets exactly two cookies, both with
 * the same hardened flags, so a dependency would be more surface than value.
 *
 * Flags are not configurable on purpose (doc 02): httpOnly keeps the session out
 * of reach of any script, Secure keeps it off plaintext hops, SameSite=Lax blunts
 * CSRF while still surviving a top-level navigation back into the app.
 *
 * Secure is set even on http://localhost, which browsers treat as a secure
 * context. Chromium and Firefox honour that; older Safari does not, so develop
 * against Chromium or a TLS tunnel.
 */

export const SESSION_COOKIE = "retenix_session";

/*
 * Presence-only routing hint for proxy.ts, which runs where neither
 * SESSION_SECRET nor the database is reachable. Never an authorization decision.
 * The names live here rather than in session.ts so the proxy can read them
 * without dragging in the typed env module.
 */
export const GATE_COOKIE = "retenix_gate";

export type CookieOptions = {
  /** Seconds. Zero expires the cookie immediately. */
  maxAge: number;
};

export function serializeCookie(
  name: string,
  value: string,
  { maxAge }: CookieOptions,
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed percent-escape is an unusable value, not a reason to 500.
    }
  }
  return out;
}
