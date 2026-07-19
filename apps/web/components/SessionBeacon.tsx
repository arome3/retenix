"use client";

import { useEffect, useRef } from "react";

import { reportSessionStart } from "@/lib/ui-telemetry";

/**
 * Records that a session began (PS-8.2). Renders nothing.
 *
 * This is the DENOMINATOR of "≥60% of sessions include zero chain-name
 * exposure": a clean session emits no ui.network_named row by definition, so
 * without this the metric could only ever divide exposed sessions by exposed
 * sessions and report 100%.
 *
 * Mounted in the (app) shell, which has already awaited requireSession().
 */
export function SessionBeacon() {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    reportSessionStart();
  }, []);
  return null;
}
