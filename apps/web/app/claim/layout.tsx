import { ThemeScope } from "@/components/ThemeScope";

// S6 heir claim (doc 14) renders paper-light even for dark-mode users —
// separate emotional register. Hard loads are handled pre-paint by the init
// script in the root layout (it knows /claim); ThemeScope holds the force
// for the client session and restores the stored mode on exit.
export default function ClaimLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <ThemeScope defaultMode="light" force />
      <div className="mx-auto min-h-dvh w-full max-w-[480px] bg-background px-4 text-foreground md:px-6">
        {children}
      </div>
    </>
  );
}
