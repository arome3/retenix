"use client";

import { useEffect } from "react";
import { applyDefaultMode, forceLight, type ThemeMode } from "@/lib/theme";

/**
 * Declares a route group's theme default (doc 01 step 3). The pre-paint init
 * script in app/layout.tsx handles hard loads; this component covers
 * client-side navigations between groups.
 *
 * - `(app)` shell:        <ThemeScope defaultMode="dark" />
 * - `(onboarding)`:       <ThemeScope defaultMode="light" />
 * - `claim` (S6, doc 14): <ThemeScope defaultMode="light" force /> — paper
 *   even for dark-mode users; their stored preference is untouched and
 *   restored on unmount.
 */
export function ThemeScope({
  defaultMode,
  force = false,
}: {
  defaultMode: ThemeMode;
  force?: boolean;
}) {
  useEffect(() => {
    if (force && defaultMode === "light") {
      return forceLight();
    }
    applyDefaultMode(defaultMode);
  }, [defaultMode, force]);

  return null;
}
