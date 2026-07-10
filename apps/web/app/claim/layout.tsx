import { ThemeScope } from "@/components/ThemeScope";

// S6 heir claim (doc 14) renders paper-light even for dark-mode users —
// separate emotional register. The inline script mirrors the head init script
// for streamed/edge cases; ThemeScope holds the force for the client session.
export default function ClaimLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: 'document.documentElement.classList.remove("dark");',
        }}
      />
      <ThemeScope defaultMode="light" force />
      <div className="mx-auto min-h-dvh w-full max-w-[480px] bg-background px-4 text-foreground md:px-6">
        {children}
      </div>
    </>
  );
}
