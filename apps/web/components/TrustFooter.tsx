import Link from "next/link";
import { ShieldCheck } from "lucide-react";

// C13 · TrustFooter (design system §7) — the persistent Profile badge:
// "Self-custodial — your keys, your account" → the security page. Verbatim.
export function TrustFooter() {
  return (
    <Link
      href="/profile/security"
      className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-micro hover:bg-muted"
    >
      <ShieldCheck
        className="size-5 shrink-0 text-primary"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <span className="text-body text-foreground">
        Self-custodial — your keys, your account
      </span>
    </Link>
  );
}
