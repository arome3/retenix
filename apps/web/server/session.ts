import { parseCookieHeader } from "@/lib/cookies";
import {
  SESSION_COOKIE,
  clearedSetCookies,
  sessionSetCookies,
  signSession,
  verifySession,
  type SessionPayload,
  type VerifiedSession,
} from "@/lib/session";

/*
 * Server-side session access. Everything here is request-scoped: the tRPC context
 * threads resHeaders through so a procedure can mint or clear the cookie, and
 * server components read the jar directly.
 */

export type ResponseCtx = { resHeaders: Headers };

/** Verifies the session cookie carried by an incoming request. */
export async function readSession(
  headers: Headers,
): Promise<VerifiedSession | null> {
  const jar = parseCookieHeader(headers.get("cookie"));
  return await verifySession(jar[SESSION_COOKIE]);
}

/**
 * Server-component / route-handler helper. next/headers is imported lazily so
 * this module stays importable from plain unit tests.
 */
export async function getSession(): Promise<VerifiedSession | null> {
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  return await verifySession(jar.get(SESSION_COOKIE)?.value);
}

export async function setSessionCookie(
  ctx: ResponseCtx,
  payload: SessionPayload,
): Promise<void> {
  const token = await signSession(payload);
  for (const cookie of sessionSetCookies(token, payload.region)) {
    ctx.resHeaders.append("set-cookie", cookie);
  }
}

export function clearSessionCookie(ctx: ResponseCtx): void {
  for (const cookie of clearedSetCookies()) {
    ctx.resHeaders.append("set-cookie", cookie);
  }
}
