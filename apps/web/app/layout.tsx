import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import Script from "next/script";
import { ThemeHydration } from "@/components/ThemeHydration";
import { Providers } from "./providers";
import "./globals.css";

// The three faces (design system §3), self-hosted via next/font — no
// third-party font CDN at runtime. Their variables feed the §11 font tokens
// (--font-display / --font-sans / --font-mono) in globals.css.
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
  subsets: ["latin"],
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Retenix", template: "%s · Retenix" },
  description: "A self-custodial brokerage run by agents you can read.",
  applicationName: "Retenix",
  appleWebApp: {
    capable: true,
    title: "Retenix",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // safe-area insets reach the tab bar and sheets
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0e11" }, // graphite-950
    { media: "(prefers-color-scheme: light)", color: "#fbfaf8" }, // paper-50
  ],
};

// Runs before first paint: dark is the app default, onboarding/marketing
// default light, /claim is always light (S6 forces paper even for dark-mode
// users — doc 14). localStorage failures (private mode) fall through to the
// route defaults. Keys and semantics live in lib/theme.ts.
const themeInit = `(function () {
  try {
    var d = document.documentElement;
    var p = location.pathname;
    var forcedLight = p === "/claim" || p.indexOf("/claim/") === 0;
    var lightDefault = forcedLight || p === "/" || /^\\/(welcome|otp|eligibility|ready)(\\/|$)/.test(p);
    var mode = null, cvd = null;
    try {
      mode = localStorage.getItem("retenix:theme");
      cvd = localStorage.getItem("retenix:cvd");
    } catch (e) {}
    var dark = forcedLight
      ? false
      : mode === "dark" || mode === "light"
        ? mode === "dark"
        : !lightDefault;
    d.classList.toggle("dark", dark);
    if (cvd === "1") d.classList.add("cvd");
  } catch (e) {}
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Theme classes (`dark`/`cvd`) live on <html>, owned exclusively by the
  // init script + lib/theme.ts. React renders NO className there — hydration
  // would clobber script-applied classes otherwise — so the font variables
  // (inherited custom properties) sit on <body> instead.
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${instrumentSerif.variable} ${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Script
          id="theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeInit }}
        />
        <ThemeHydration />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
