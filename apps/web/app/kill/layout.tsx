import { ThemeScope } from "@/components/ThemeScope";
import { requireSession } from "@/server/require-session";

// C7's full-screen crimson surface (doc 13) lives OUTSIDE the (app) tab
// chrome — a sibling route group, the claim/ escape pattern. No TabBar, no
// countdown banner: the kill switch is a single-purpose surface. The crimson
// is the --destructive token (doc 01 has no separate crimson-600 utility);
// destructive-foreground on it measures 5.08:1 (module 01's contrast run).
export default async function KillLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // proxy.ts already requires the session cookie for /kill (not UNGATED);
  // this is the authoritative check a forged cookie runs into. Deliberately
  // NOT region-gated beyond requireSession's own rule — the kill switch is
  // the safety surface (doc 13 security model).
  await requireSession();

  return (
    <>
      <ThemeScope defaultMode="dark" />
      <div className="min-h-dvh w-full bg-destructive text-destructive-foreground">
        <div className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] md:px-6">
          {children}
        </div>
      </div>
    </>
  );
}
