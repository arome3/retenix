"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";
import { magicLogout } from "@/lib/magic";
import { endOnboarding } from "@/lib/onboarding";
import { trpc } from "@/lib/trpc";

/*
 * Ends both halves of the session: Magic's, and the httpOnly cookie only the
 * server can clear. The final navigation is a full load, not a client push, so
 * the react-query cache and every rendered balance leave with it.
 */
const MAGIC_LOGOUT_TIMEOUT_MS = 3_000;

export function SignOutRow() {
  const logout = trpc.auth.logout.useMutation();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      // A Magic outage must never trap someone in a session. Give it a moment,
      // then clear our own cookie regardless.
      await Promise.race([
        magicLogout(),
        new Promise((resolve) => setTimeout(resolve, MAGIC_LOGOUT_TIMEOUT_MS)),
      ]);
    } catch {
      // Magic may already consider us signed out; the cookie still must go.
    }
    try {
      await logout.mutateAsync();
    } finally {
      endOnboarding();
      window.location.assign("/welcome");
    }
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={pending}
      className="flex w-full items-center gap-3 rounded-lg border border-border p-4 text-left transition-micro hover:bg-card disabled:opacity-50"
    >
      <LogOut className="size-5 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
      <span className="text-body">{pending ? "Signing out…" : "Sign out"}</span>
    </button>
  );
}
