import { NextResponse, type NextRequest } from "next/server";
import { GATE_COOKIE, SESSION_COOKIE } from "@/lib/cookies";

/*
 * Route gating (doc 02). Two rules:
 *
 *   no session            -> only the entry surfaces
 *   session, no region    -> only the eligibility gate (doc 04 owns its content)
 *
 * This runs at the edge, where the database is unreachable and SESSION_SECRET is
 * not dependable, so it decides on cookie *presence* alone. That makes it an
 * optimistic redirect, not an authorization boundary: a hand-forged retenix_gate
 * buys exactly one navigation, because app/(app)/layout.tsx and /ready verify the
 * signed session and re-read users.region from the database, and every procedure
 * gates on ctx.session. Cheap in the common case, authoritative where it counts.
 */

/** Surfaces that must answer before, or without, a session. */
const ENTRY = /^\/(?:welcome|otp)(?:\/|$)/;
/** The eligibility gate — doc 04 fills it in; S1 hosts it. */
const GATE = /^\/eligibility(?:\/|$)/;
/** Never gated: the API gates itself, and these are outside the authed shell. */
const UNGATED = /^\/(?:api|dev|help|claim)(?:\/|$)/;

const HOME = "/home";
const WELCOME = "/welcome";
const ELIGIBILITY = "/eligibility";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (UNGATED.test(pathname)) return NextResponse.next();

  const to = (path: string) =>
    NextResponse.redirect(new URL(path, request.nextUrl));

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  if (!hasSession) {
    const isEntry = pathname === "/" || ENTRY.test(pathname);
    return isEntry ? NextResponse.next() : to(WELCOME);
  }

  const hasRegion = Boolean(request.cookies.get(GATE_COOKIE)?.value);
  if (!hasRegion) {
    return GATE.test(pathname) ? NextResponse.next() : to(ELIGIBILITY);
  }

  // The gate is never redirected away from, even when the cookie says it is
  // done. Only the gate page reads users.region, and if it disagreed with the
  // cookie the two redirects would chase each other forever. It sends a
  // finished user onward itself.
  if (GATE.test(pathname)) return NextResponse.next();

  // Onboarding is over; its entry screens are no longer somewhere to be.
  const isEntry = pathname === "/" || ENTRY.test(pathname);
  return isEntry ? to(HOME) : NextResponse.next();
}

export const config = {
  matcher: [
    // Everything except Next internals and files served straight off disk.
    "/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|svg|ico|webmanifest|txt|xml)$).*)",
  ],
};
