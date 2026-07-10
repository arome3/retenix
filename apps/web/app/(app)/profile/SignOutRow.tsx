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
export function SignOutRow() {
  const logout = trpc.auth.logout.useMutation();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await magicLogout();
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
