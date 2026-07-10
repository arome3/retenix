import { HelpLink } from "@/components/HelpLink";
import { SkipToContent } from "@/components/SkipToContent";
import { ThemeScope } from "@/components/ThemeScope";

// S1 route group: welcome, otp, eligibility (modules 02, 04 fill in).
// Onboarding renders light by default (trust surface); a stored user
// preference still wins. Help sits at the bottom of the flow (WCAG 3.2.6).
export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <SkipToContent />
      <ThemeScope defaultMode="light" />
      <div className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col px-4 md:px-6">
        <main id="main" className="flex-1">
          {children}
        </main>
        <footer className="flex justify-center py-6 pb-safe">
          <HelpLink />
        </footer>
      </div>
    </>
  );
}
