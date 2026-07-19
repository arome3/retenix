"use client";

import { useEffect } from "react";
import type { NamedSurface } from "@retenix/shared";

import { reportNamed } from "@/lib/ui-telemetry";

/**
 * Reports, at most once per tab session per surface, that this surface put a
 * source's proper name on screen (PS-8.2).
 *
 * `shown` gates on the DATA, not the mount. An expanded receipt whose sources
 * are empty reveals nothing, and a sheet that is mounted-but-closed reveals
 * nothing — counting either would make the metric flatter itself in the
 * direction that matters.
 */
export function useNamedSource(surface: NamedSurface, shown: boolean): void {
  useEffect(() => {
    if (shown) reportNamed(surface);
  }, [surface, shown]);
}
