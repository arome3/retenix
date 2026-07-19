import { CountdownBanner } from "@/components/CountdownBanner";
import { CountdownBannerSlot } from "@/components/CountdownBannerSlot";
import { SkipToContent } from "@/components/SkipToContent";
import { TabBar } from "@/components/TabBar";
import { ThemeScope } from "@/components/ThemeScope";
import { requireSession } from "@/server/require-session";

// Authed shell (doc 01 §App shell): centered 480px column on desktop, dark by
// default, countdown-banner slot above every screen (doc 14 fills it), bottom
// tabs clear of the home indicator. Pages own their headers — the kill switch
// belongs to the Home header (doc 13), never the tabs.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Authoritative session + region check (doc 02). proxy.ts already redirected
  // the common cases; this is what a forged cookie runs into.
  const session = await requireSession();

  return (
    <>
      <SkipToContent />
      <ThemeScope defaultMode="dark" />
      <div className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col">
        <CountdownBannerSlot />
        {/* C8 (doc 14) — portals into the slot above while a countdown is live */}
        <CountdownBanner eoa={session.eoa} />
        <main
          id="main"
          className="flex-1 px-4 pb-[calc(3.5rem+env(safe-area-inset-bottom)+1.5rem)] md:px-6"
        >
          {children}
        </main>
      </div>
      <TabBar />
    </>
  );
}
