"use client";

import { useSyncExternalStore } from "react";

const subscribeNoop = () => () => {};

/**
 * False during SSR and the hydration render, true afterwards — the sanctioned
 * gate for client-only values (clocks, localStorage, platform detection)
 * without setState-in-effect cascades.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}
