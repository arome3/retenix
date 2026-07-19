import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { SecurityScreen } from "@/components/SecurityScreen";
import { requireSession } from "@/server/require-session";

export const metadata: Metadata = { title: "How your money is protected" };

// C13 · SecurityPage (doc 15) — delegation transparency as a feature page.
export default async function Page() {
  const session = await requireSession();
  return (
    <div>
      <Link
        href="/profile"
        className="mt-6 inline-flex items-center gap-1 text-small text-muted-foreground transition-micro hover:text-foreground"
      >
        <ChevronLeft className="size-4" strokeWidth={1.5} aria-hidden="true" />
        Profile
      </Link>
      <SecurityScreen eoa={session.eoa} />
    </div>
  );
}
