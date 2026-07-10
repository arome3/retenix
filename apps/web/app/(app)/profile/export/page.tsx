import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { KeyExportFlow } from "@/components/KeyExportFlow";

export const metadata: Metadata = { title: "Export your key" };

// C14's confirm screen. The reveal itself belongs to Magic; this page only makes
// the choice legible before the modal opens.
export default function ExportKeyPage() {
  return (
    <div className="space-y-8 py-6">
      <Link
        href="/profile"
        className="inline-flex min-h-6 items-center gap-1 text-small text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ChevronLeft className="size-4" strokeWidth={1.5} aria-hidden="true" />
        Profile
      </Link>
      <KeyExportFlow />
    </div>
  );
}
