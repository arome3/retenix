import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, CircleHelp, KeyRound, ShieldCheck } from "lucide-react";
import {
  AccessibleColorsRow,
  AccountRow,
  InstallTeachRow,
} from "@/components/ProfileSettingsRows";
import { TrustFooter } from "@/components/TrustFooter";
import { requireSession } from "@/server/require-session";
import { SignOutRow } from "./SignOutRow";

export const metadata: Metadata = { title: "Profile" };

// Profile (doc 15) — the app's honest desk: identity, the self-custody proof
// surfaces (C13 badge + page, C14 key export), accessibility, help, sign out.
// No upsells, no dark corners. Row order is the doc-15 list.
export default async function ProfilePage() {
  const session = await requireSession();
  return (
    <div className="space-y-6 py-6">
      <h1 className="font-display text-display leading-tight">Profile</h1>

      {/* C13 TrustFooter — the persistent badge, verbatim copy */}
      <TrustFooter />

      <section
        className="divide-y divide-border rounded-lg border border-border"
        aria-label="Your account"
      >
        <AccountRow region={session.region} />

        <Link
          href="/profile/security"
          className="flex items-center gap-3 p-4 transition-micro hover:bg-card"
        >
          <ShieldCheck
            className="size-5 text-muted-foreground"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span className="flex-1">
            <span className="block text-body">Security &amp; protection</span>
            <span className="block text-small text-muted-foreground">
              How your money is protected
            </span>
          </span>
          <ChevronRight
            className="size-5 text-muted-foreground"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </Link>

        <Link
          href="/profile/export"
          className="flex items-center gap-3 p-4 transition-micro hover:bg-card"
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

        <AccessibleColorsRow />

        <InstallTeachRow />

        <Link
          href="/help"
          className="flex items-center gap-3 p-4 transition-micro hover:bg-card"
        >
          <CircleHelp
            className="size-5 text-muted-foreground"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span className="flex-1 text-body">Help</span>
          <ChevronRight
            className="size-5 text-muted-foreground"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </Link>
      </section>

      <SignOutRow />
    </div>
  );
}
