import type { Metadata } from "next";

// PROPOSED (spec-silent): WCAG 3.2.6 needs a consistent help destination; the
// HelpLink component points here from Profile and every flow footer. Content
// is intentionally minimal — a person, not a maze.
export const metadata: Metadata = { title: "Help" };

export default function HelpPage() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col gap-4 px-4 py-12 md:px-6"
    >
      <h1 className="font-display text-display">Help</h1>
      <p className="text-body text-muted-foreground">
        A person reads every message. Write to{" "}
        <a
          href="mailto:support@retenix.app"
          className="text-primary underline-offset-4 hover:underline"
        >
          support@retenix.app
        </a>{" "}
        and we&apos;ll reply by email.
      </p>
      <p className="text-small text-muted-foreground">
        Your money stays in your own account either way — nothing here can
        move it.
      </p>
    </main>
  );
}
