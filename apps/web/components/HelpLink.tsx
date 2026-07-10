import Link from "next/link";
import { CircleHelp } from "lucide-react";
import { cn } from "@/lib/utils";

// Consistent help placement (WCAG 3.2.6): the same link, the same way, at
// Profile and at the bottom of every flow. Flow layouts render it in their
// footer (see the onboarding layout); modules 02/04/10/15 keep the pattern.
export function HelpLink({ className }: { className?: string }) {
  return (
    <Link
      href="/help"
      className={cn(
        "inline-flex min-h-6 items-center gap-1.5 text-small text-muted-foreground underline-offset-4 transition-micro hover:text-foreground hover:underline",
        className,
      )}
    >
      <CircleHelp className="size-4" strokeWidth={1.5} aria-hidden="true" />
      Help
    </Link>
  );
}
