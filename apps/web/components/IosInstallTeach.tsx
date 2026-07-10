"use client";

import { useEffect, useState } from "react";
import { Share, SquarePlus, X } from "lucide-react";
import { cn } from "@/lib/utils";

// iOS install is manual (§App shell & PWA): one card, two steps, shown once.
// Module 02 renders it at the end of onboarding; module 15 re-reaches it from
// Profile with `force` (and can clear the dismissal via resetInstallTeach).

const DISMISS_KEY = "retenix:install-teach-dismissed";

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const classic = /iPhone|iPad|iPod/i.test(ua);
  // iPadOS 13+ reports as macOS but is the only Mac with touch points
  const ipadOs = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
  return classic || ipadOs;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator &&
      (navigator as { standalone?: boolean }).standalone === true)
  );
}

/** Clears the shown-once dismissal (Profile → re-show, doc 15). */
export function resetInstallTeach(): void {
  try {
    localStorage.removeItem(DISMISS_KEY);
  } catch {
    // private mode — nothing stored to clear
  }
}

export function IosInstallTeach({
  force = false,
  className,
  onDismiss,
}: {
  /** Renders regardless of platform/dismissal — the Profile re-reach and /dev/tokens. */
  force?: boolean;
  className?: string;
  onDismiss?: () => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (force) {
      setVisible(true);
      return;
    }
    try {
      if (localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      // private mode — show; dismissal just won't persist
    }
    if (isIos() && !isStandalone()) setVisible(true);
  }, [force]);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // private mode
    }
    onDismiss?.();
  };

  return (
    <section
      aria-label="Add Retenix to your Home Screen"
      className={cn(
        "relative rounded-lg border border-border bg-card p-4 text-card-foreground shadow-soft",
        className,
      )}
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute top-3 right-3 flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-micro hover:text-foreground"
      >
        <X className="size-4" strokeWidth={1.5} />
      </button>
      <h2 className="pr-8 text-h2 font-medium">Keep Retenix on your Home Screen</h2>
      <p className="mt-1 text-small text-muted-foreground">
        Two steps in Safari — then Retenix opens full-screen, like any app.
      </p>
      <ol className="mt-4 flex flex-col gap-3">
        <li className="flex items-center gap-3 text-small">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
            <Share className="size-5" strokeWidth={1.5} aria-hidden="true" />
          </span>
          <span>
            Tap the <span className="font-medium">Share</span> button in the
            toolbar
          </span>
        </li>
        <li className="flex items-center gap-3 text-small">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
            <SquarePlus className="size-5" strokeWidth={1.5} aria-hidden="true" />
          </span>
          <span>
            Choose <span className="font-medium">Add to Home Screen</span>
          </span>
        </li>
      </ol>
    </section>
  );
}
