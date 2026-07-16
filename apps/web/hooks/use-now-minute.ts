"use client";

import { useSyncExternalStore } from "react";

/*
 * Minute-grain wall clock as an external store — render must never read
 * Date.now() (react-hooks/purity; BuyingPowerHeader.tsx established the
 * pattern for its "as of Nm ago" label). Checked every 30s: exactly the
 * resolution a relative timestamp can express. The server snapshot pins 0,
 * which is safe here because feed rows only render client-side (the query has
 * no SSR data — the server paints the skeleton).
 */
const MINUTE_MS = 60_000;

const subscribeClock = (onChange: () => void) => {
  const id = setInterval(onChange, 30_000);
  return () => clearInterval(id);
};
const readMinute = () => Math.floor(Date.now() / MINUTE_MS);
const readMinuteServer = () => 0;

/** The current time in ms at minute grain. Consumers that must freeze it
 *  (feed pause, WCAG 2.2.2) capture Date.now() in their event handler and
 *  render the captured value instead — see useFeed. */
export function useNowMinute(): number {
  return useSyncExternalStore(subscribeClock, readMinute, readMinuteServer) * MINUTE_MS;
}
