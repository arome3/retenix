"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { reapplyTheme } from "@/lib/theme";

/**
 * Mounted once in the root layout. The pre-paint init script sets the theme
 * classes before first paint; this re-asserts them after hydration (React
 * committing <html> can drop script-applied classes) and on every client-side
 * navigation. Route-group ThemeScope components keep their explicit
 * semantics on top — all writers share lib/theme.ts logic.
 */
export function ThemeHydration() {
  const pathname = usePathname();

  useEffect(() => {
    reapplyTheme(pathname);
  }, [pathname]);

  return null;
}
