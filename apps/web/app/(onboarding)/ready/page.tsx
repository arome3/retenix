import type { Metadata } from "next";
import Link from "next/link";
import { CopyChip } from "@/components/CopyChip";
import { IosInstallTeach } from "@/components/IosInstallTeach";
import { Button } from "@/components/ui/button";
import { requireSession } from "@/server/require-session";
import { ReadyTracker } from "./ReadyTracker";

export const metadata: Metadata = { title: "Your account is ready" };

// S1.4 (DS-S1). The address is read from the verified session, not from the
// browser: what we show is what the server proved. One way forward, and then
// the install teach closes the flow (doc 01).
export default async function ReadyPage() {
  const user = await requireSession();

  return (
    <div className="flex min-h-[80dvh] flex-col justify-center gap-8 py-12">
      <ReadyTracker />

      <header className="space-y-3">
        <h1 className="font-display text-display leading-tight">
          Your account is ready
        </h1>
        <p className="text-body text-muted-foreground">
          It is yours. Retenix cannot move anything you have not allowed.
        </p>
      </header>

      <div className="space-y-2 rounded-lg border border-border p-4">
        <p className="text-caption text-muted-foreground">Your address</p>
        <CopyChip address={user.eoa} />
      </div>

      <Button asChild className="w-full">
        <Link href="/home" prefetch>
          Continue
        </Link>
      </Button>

      <IosInstallTeach />
    </div>
  );
}
