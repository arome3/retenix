"use client";

import { useSyncExternalStore } from "react";

/*
 * Second-grain wall clock — use-now-minute's pattern at countdown resolution
 * (C8's digits change every second at demo scale; render must never read
 * Date.now() directly — react-hooks/purity). Only mounted while a countdown
 * banner is live, so the 1s interval never runs idle.
 */
const subscribeClock = (onChange: () => void) => {
  const id = setInterval(onChange, 1_000);
  return () => clearInterval(id);
};
const readSecond = () => Math.floor(Date.now() / 1_000);
const readSecondServer = () => 0;

export function useNowSecond(): number {
  return useSyncExternalStore(subscribeClock, readSecond, readSecondServer) * 1_000;
}
