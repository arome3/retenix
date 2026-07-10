"use client";

import { useEffect, useRef, useState } from "react";

// Balance changes count up over 400ms, once per session load — not on every
// tick (§6). Under prefers-reduced-motion the final value renders instantly
// (WCAG 2.3.3 / C39). This is the ceiling for trade acknowledgment: count-up
// plus a subtle check, never celebration (law 2 / G15).

// Keys that have already played this page load. Module scope means "per
// session load" exactly: reloading the app replays, navigating doesn't.
const playedKeys = new Set<string>();

export type CountUpOptions = {
  /** Animation length in ms (motion table: 400 for balance count-ups). */
  duration?: number;
  /**
   * Identity of the number being introduced (e.g. "buying-power"). With a
   * key, the count-up plays only the first time that key mounts per session
   * load; later mounts and value updates snap. Without a key, each mount of
   * the hook animates once.
   */
  sessionKey?: string;
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// ease-out cubic — entrances decelerate (§6)
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * Animates 0 → value on first mount, then snaps on subsequent updates.
 * Returns the number to render (format it with fmtUsd/fmtPct inside <Num>).
 */
export function useCountUp(
  value: number,
  { duration = 400, sessionKey }: CountUpOptions = {},
): number {
  // Initial render always shows the final value — identical on server and
  // client, so SSR hydration never sees mismatched text. The animation (from
  // 0) starts in the effect, after first paint.
  const [display, setDisplay] = useState(value);
  const playedRef = useRef(false);
  const targetRef = useRef(value);

  useEffect(() => {
    targetRef.current = value;
    const alreadyPlayed =
      playedRef.current ||
      (sessionKey !== undefined && playedKeys.has(sessionKey));
    if (alreadyPlayed || prefersReducedMotion()) {
      // once-per-session already spent (or reduced motion): snap on updates
      setDisplay(targetRef.current);
      return;
    }
    playedRef.current = true;
    if (sessionKey !== undefined) playedKeys.add(sessionKey);

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      setDisplay(easeOut(t) * targetRef.current);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // a value change mid-flight re-runs the effect, lands in the snap branch
    // above, and this cleanup cancels the animation — ticks never re-animate
    return () => cancelAnimationFrame(raf);
  }, [value, duration, sessionKey]);

  return display;
}
