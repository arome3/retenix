import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, KeyRound } from "lucide-react";
import { SignOutRow } from "./SignOutRow";

export const metadata: Metadata = { title: "Profile" };

// Module 15 assembles this screen: theme and accessible-colors toggles, the
// send/withdraw entry, and C13's TrustFooter linking "How your money is
// protected" — its security-page slot is marked below. Module 02 contributes
// only the two rows it owns: key export (C14) and sign out.
export default function ProfilePage() {
  return (
    <div className="space-y-8 py-6">
      <h1 className="font-display text-display leading-tight">Profile</h1>

      <section className="space-y-3" aria-label="Your account">
        <Link
          href="/profile/export"
          className="flex items-center gap-3 rounded-lg border border-border p-4 transition-micro hover:bg-card"
        >
          <KeyRound
            className="size-5 text-muted-foreground"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span className="flex-1">
            <span className="block text-body">Export your key</span>
            <span className="block text-small text-muted-foreground">
              Your account is a standard address. Take it anywhere.
            </span>
          </span>
          <ChevronRight
            className="size-5 text-muted-foreground"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </Link>

        {/* TODO(doc 15): C13 SecurityPage row — "How your money is protected". */}

        <SignOutRow />
      </section>
    </div>
  );
}
