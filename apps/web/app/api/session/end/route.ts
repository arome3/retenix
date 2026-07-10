import { NextResponse } from "next/server";
import { clearedSetCookies } from "@/lib/session";

/*
 * Ends a session that can no longer be honoured — a valid cookie whose user row
 * is gone. proxy.ts cannot see that (no database at the edge), so without this
 * the shell would redirect to the gate and the gate back to the shell forever.
 *
 * The Sign out button uses auth.logout; this is the escape hatch, not the door.
 */
export function GET(request: Request) {
  const response = NextResponse.redirect(new URL("/welcome", request.url));
  for (const cookie of clearedSetCookies()) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}
