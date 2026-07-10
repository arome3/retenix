import type { Metadata } from "next";
import { WelcomeForm } from "./WelcomeForm";

export const metadata: Metadata = { title: "Welcome" };

// S1.1 (DS-S1): wordmark, one-line promise, a single email field. No password,
// no puzzle, no connect button — passwordless email satisfies WCAG 3.3.8, and
// there is nothing here to choose that a person should not have to think about.
export default function WelcomePage() {
  return (
    <div className="flex min-h-[80dvh] flex-col justify-center gap-10 py-12">
      <header className="space-y-3">
        <h1 className="font-display text-display-xl leading-none">Retenix</h1>
        <p className="text-body text-muted-foreground">
          Investing that runs itself, and always answers to you.
        </p>
      </header>
      <WelcomeForm />
    </div>
  );
}
