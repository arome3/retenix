// Theme switching (doc 01 §Implementation guide step 3).
//
// Class strategy on <html>: `dark` (default for app surfaces) and `cvd`
// ("Accessible colors" — composable with either mode, DS-2.2). Preferences
// persist in localStorage; the pre-paint init script in app/layout.tsx reads
// the same keys so a hard load never flashes the wrong theme. If storage is
// unavailable (private mode) every setter still applies classes for the
// session and the route defaults keep rendering.
//
// Downstream consumers:
//  - doc 15 Profile "Accessible colors" toggle → setCvd()
//  - doc 15 Profile appearance rows → setThemeMode()
//  - doc 02/15 user-row mirroring → registerThemeMirror()
//  - doc 14 S6 claim route → <ThemeScope defaultMode="light" force />

import { useSyncExternalStore } from "react";

export type ThemeMode = "dark" | "light";
export type ThemePrefs = { mode: ThemeMode; cvd: boolean };

const MODE_KEY = "retenix:theme";
const CVD_KEY = "retenix:cvd";

// graphite-950 / paper-50 — keeps the browser/PWA chrome in step with the
// surface behind it when the user switches at runtime.
const CHROME_COLOR: Record<ThemeMode, string> = {
  dark: "#0b0e11",
  light: "#fbfaf8",
};

const SERVER_SNAPSHOT: ThemePrefs = { mode: "dark", cvd: false };

type Listener = (prefs: ThemePrefs) => void;
const listeners = new Set<Listener>();

// Optional persistence to the user row; the Profile surface (doc 15) wires
// this to a tRPC mutation once auth (doc 02) exists.
let mirror: Listener | null = null;

// While > 0, mode changes don't touch the DOM (the S6 claim surface is
// always paper-light) but preferences still persist for the rest of the app.
let forcedLightCount = 0;

let snapshot: ThemePrefs = SERVER_SNAPSHOT;

function root(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

function readStoredMode(): ThemeMode | null {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

function readStoredCvd(): boolean | null {
  try {
    const v = localStorage.getItem(CVD_KEY);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode — session-only theming still works via classes
  }
}

function syncChromeColor(): void {
  const el = root();
  if (!el) return;
  const mode: ThemeMode = el.classList.contains("dark") ? "dark" : "light";
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((m) => {
      m.content = CHROME_COLOR[mode];
    });
}

function emit(): void {
  snapshot = getThemePrefs();
  syncChromeColor();
  listeners.forEach((fn) => fn(snapshot));
}

/** Current prefs as rendered (reads the <html> classes, the source of truth). */
export function getThemePrefs(): ThemePrefs {
  const el = root();
  if (!el) return SERVER_SNAPSHOT;
  return {
    mode: el.classList.contains("dark") ? "dark" : "light",
    cvd: el.classList.contains("cvd"),
  };
}

/** Sets and persists dark/light. No-ops on the DOM inside a forced-light scope. */
export function setThemeMode(mode: ThemeMode): void {
  write(MODE_KEY, mode);
  const el = root();
  if (el && forcedLightCount === 0) el.classList.toggle("dark", mode === "dark");
  emit();
  mirror?.(getThemePrefs());
}

/** The "Accessible colors" toggle (DS-2.2) — independent of dark/light. */
export function setCvd(on: boolean): void {
  write(CVD_KEY, on ? "1" : "0");
  root()?.classList.toggle("cvd", on);
  emit();
  mirror?.(getThemePrefs());
}

/**
 * Registers user-row persistence for theme changes (called with the new prefs
 * after every set*). Modules 02/15 wire this to their tRPC mutation; passing
 * null unregisters.
 */
export function registerThemeMirror(fn: Listener | null): void {
  mirror = fn;
}

/** Applies a route-group default without persisting — only when the user has
 *  no stored preference. Client-side navigations re-run this via ThemeScope. */
export function applyDefaultMode(mode: ThemeMode): void {
  if (readStoredMode() !== null) {
    // stored preference wins outside forced scopes; re-assert it in case a
    // forced-light route was visited earlier in this session
    if (forcedLightCount === 0) {
      root()?.classList.toggle("dark", readStoredMode() === "dark");
      emit();
    }
    return;
  }
  if (forcedLightCount === 0) {
    root()?.classList.toggle("dark", mode === "dark");
    emit();
  }
  const cvd = readStoredCvd();
  if (cvd !== null) {
    root()?.classList.toggle("cvd", cvd);
    emit();
  }
}

/**
 * Forces paper-light while the returned release function is not called
 * (S6 claim — doc 14). Nestable; restores the stored/derived mode on release.
 */
export function forceLight(): () => void {
  forcedLightCount += 1;
  root()?.classList.remove("dark");
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    forcedLightCount -= 1;
    if (forcedLightCount === 0) {
      const stored = readStoredMode();
      root()?.classList.toggle("dark", stored !== "light");
      emit();
    }
  };
}

export function subscribeTheme(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function subscribe(onStoreChange: () => void): () => void {
  return subscribeTheme(onStoreChange);
}

function getSnapshot(): ThemePrefs {
  // recompute lazily (the pre-paint init script mutates classes before any
  // emit) but keep referential stability for useSyncExternalStore
  const current = getThemePrefs();
  if (current.mode !== snapshot.mode || current.cvd !== snapshot.cvd) {
    snapshot = current;
  }
  return snapshot;
}

function getServerSnapshot(): ThemePrefs {
  return SERVER_SNAPSHOT;
}

/** React hook — re-renders on theme changes. Client components only. */
export function useThemePrefs(): ThemePrefs {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
