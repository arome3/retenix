"use client";

import { KILL_HOLD_MS, KILL_RETRYABLE_STATES } from "@retenix/shared";
import { warmRegistry } from "@retenix/registry";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { KillProgress } from "@/components/KillProgress";
import { KILL_TAP_KEY } from "@/components/KillSwitchSlot";
import { Num } from "@/components/Num";
import {
  browserUa,
  runKill,
  type KillProgress as RunnerProgress,
} from "@/lib/kill-runner";
import { trpcVanilla } from "@/lib/trpc-vanilla";

/*
 * C7 · KillSwitch (doc 13, design system §7 verbatim): full-screen crimson,
 * press-and-hold 1.5 s with a progress ring — the ONE permitted glow (teal,
 * DS-4.3). Releasing early cancels. Keyboard equivalent: Enter to arm + a
 * confirm button (DS-10.8). Reduced motion: a 1.5 s timer with static
 * progress text instead of the animated ring.
 *
 * THE HOLD IS THE CONFIRMATION. No typed word, no dialog, no cooldown, no
 * undo — deliberately lower friction than any other destructive action
 * (TS-14.5): funds can only move to the user's OWN USDC balance, so an
 * attacker with session control gains nothing here.
 */

// Verbatim C7 copy — byte-for-byte (doc 13 hard constraint; G12-compliant).
const C7_COPY =
  "Everything you hold becomes USDC in your balance. All agents lose authority. Nothing leaves your account.";

const RING_BOX = 168;
const RING_CENTER = RING_BOX / 2;
const RING_RADIUS = 72;
const RING_STROKE = 8;
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function readTapAtMs(): number | undefined {
  try {
    const raw = sessionStorage.getItem(KILL_TAP_KEY);
    if (!raw) return undefined;
    sessionStorage.removeItem(KILL_TAP_KEY);
    const n = Number(raw);
    // A stale mark (an old tab, a bookmark) would fake the AC1 clock — only a
    // recent tap counts as this kill's tap.
    return Number.isFinite(n) && Date.now() - n < 60_000 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** No hook for this existed in the repo — raw matchMedia through
 *  useSyncExternalStore (the module-12 clock-read pattern; the lint rule
 *  correctly rejects effect-sampled setState). SSR snapshot: no reduction. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// The hold button (pointer + keyboard paths)
// ---------------------------------------------------------------------------

function KillHold({ onConfirmed }: { onConfirmed: () => void }) {
  const reducedMotion = useReducedMotion();
  const [progress, setProgress] = useState(0); // 0..1 while held
  const [armed, setArmed] = useState(false); // keyboard path
  const raf = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holding = useRef(false);

  const stop = useCallback(() => {
    holding.current = false;
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    if (timer.current !== null) clearTimeout(timer.current);
    raf.current = null;
    timer.current = null;
    setProgress(0);
  }, []);

  useEffect(() => stop, [stop]);

  const complete = useCallback(() => {
    stop();
    try {
      navigator.vibrate?.(10); // haptic tick where available (PROPOSED)
      performance.mark("kill:hold-complete");
    } catch {
      /* best effort */
    }
    onConfirmed();
  }, [onConfirmed, stop]);

  const startHold = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (holding.current) return;
    holding.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const startedAt = performance.now();
    if (reducedMotion) {
      // Static text + a plain 1.5 s timer — the ring never animates.
      timer.current = setTimeout(() => {
        if (holding.current) complete();
      }, KILL_HOLD_MS);
      return;
    }
    const frame = () => {
      if (!holding.current) return;
      const p = Math.min(1, (performance.now() - startedAt) / KILL_HOLD_MS);
      setProgress(p);
      if (p >= 1) {
        complete();
        return;
      }
      raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
  };

  const cancelHold = () => {
    if (!holding.current) return;
    stop();
  };

  // Keyboard path (DS-10.8): Enter (or Space) ARMS; a visible confirm button
  // completes. Escape disarms.
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setArmed(true);
    }
  };
  useEffect(() => {
    if (!armed) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setArmed(false);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [armed]);

  const remaining = ((1 - progress) * (KILL_HOLD_MS / 1000)).toFixed(1);
  const holdActive = progress > 0;

  return (
    <div className="flex flex-col items-center gap-6">
      <button
        type="button"
        aria-label="Press and hold to liquidate and lock"
        onPointerDown={startHold}
        onPointerUp={cancelHold}
        onPointerCancel={cancelHold}
        onPointerLeave={cancelHold}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        className="relative select-none rounded-full outline-offset-4 [touch-action:none]"
      >
        <svg
          width={RING_BOX}
          height={RING_BOX}
          viewBox={`0 0 ${RING_BOX} ${RING_BOX}`}
          aria-hidden="true"
        >
          {/* track */}
          <circle
            cx={RING_CENTER}
            cy={RING_CENTER}
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.25}
            strokeWidth={RING_STROKE}
          />
          {/* The hold arc. Raw teal on crimson measures 2.81:1 (<3, WCAG
              1.4.11 — contrast.ts pins this), so the ARC is
              destructive-foreground and the teal lives in the GLOW — the one
              permitted glow (DS-4.3), decorative by definition. */}
          <g transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}>
            <circle
              cx={RING_CENTER}
              cy={RING_CENTER}
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - progress)}
              style={{ filter: "drop-shadow(0 0 8px var(--ring))" }}
            />
          </g>
        </svg>
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1">
          <span className="text-small font-medium">
            {holdActive ? "Keep holding" : "Press and hold"}
          </span>
          {reducedMotion ? null : (
            <Num className="text-caption opacity-80">{holdActive ? `${remaining}s` : "1.5s"}</Num>
          )}
        </span>
      </button>

      {armed ? (
        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={complete}
            className="rounded-lg bg-destructive-foreground px-6 py-3 font-medium text-destructive"
          >
            Confirm — Liquidate &amp; Lock
          </button>
          <button
            type="button"
            onClick={() => setArmed(false)}
            className="text-small underline underline-offset-4"
          >
            Cancel
          </button>
        </div>
      ) : (
        <p className="text-caption opacity-80">
          Hold for 1.5 seconds — or press Enter, then confirm.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

type Phase =
  | { kind: "loading" }
  | { kind: "idle" }
  | { kind: "starting"; progress: RunnerProgress | null }
  | { kind: "running"; killId: string }
  | { kind: "error"; message: string };

export function KillSurface({ eoa, region }: { eoa: string; region: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const marksRef = useRef<{ tapAtMs?: number }>({});

  // Surface-open work: pre-warm quotes for the AC1 budget (doc 05; failures
  // are non-fatal by design) and resume any interrupted kill (doc 13 crash
  // resilience — the rows are the truth). A COMPLETED kill with unfinished
  // legs also re-opens as the progress view: failed legs are retryable
  // forever without re-arming the hold (PS-F6-AC2).
  useEffect(() => {
    marksRef.current.tapAtMs = readTapAtMs();
    void warmRegistry(browserUa(eoa), region).catch(() => {});
    let cancelled = false;
    void (async () => {
      try {
        const prep = await trpcVanilla.kill.prepare.query();
        if (cancelled) return;
        if (prep.activeKillId) {
          setPhase({ kind: "running", killId: prep.activeKillId });
          // Re-run pending legs / resume polling submitted ones, headlessly.
          void runKill(eoa, {}).catch(() => {});
          return;
        }
        if (prep.lastKillId) {
          const last = await trpcVanilla.kill.status.query({ killId: prep.lastKillId });
          if (cancelled) return;
          if (last.legs.some((l) => (KILL_RETRYABLE_STATES as readonly string[]).includes(l.outcome))) {
            setPhase({ kind: "running", killId: prep.lastKillId });
            return;
          }
        }
        setPhase({ kind: "idle" });
      } catch {
        if (!cancelled) setPhase({ kind: "idle" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eoa, region]);

  const start = useCallback(() => {
    const marks = {
      tapAtMs: marksRef.current.tapAtMs,
      holdCompletedAtMs: Date.now(),
    };
    setPhase({ kind: "starting", progress: null });
    runKill(eoa, marks, (progress) => {
      setPhase((current) =>
        current.kind === "starting" ? { kind: "starting", progress } : current,
      );
    })
      .then((result) => setPhase({ kind: "running", killId: result.killId }))
      .catch((err) =>
        setPhase({
          kind: "error",
          message:
            err instanceof Error && err.message.includes("positions")
              ? err.message
              : "Couldn't start — nothing was changed. Hold again to retry.",
        }),
      );
  }, [eoa]);

  return (
    <main id="main" className="flex flex-1 flex-col justify-center gap-10 py-10">
      <header className="space-y-4">
        <h1 className="font-display text-display-lg">Liquidate &amp; Lock</h1>
        <p className="max-w-[38ch] text-body">{C7_COPY}</p>
      </header>

      {phase.kind === "loading" ? (
        <p role="status" className="text-small opacity-80">
          Checking your account…
        </p>
      ) : null}

      {phase.kind === "idle" ? <KillHold onConfirmed={start} /> : null}

      {phase.kind === "starting" ? (
        <p role="status" aria-live="polite" className="text-small">
          {phase.progress === null || phase.progress.stage === "preparing"
            ? "Preparing…"
            : phase.progress.stage === "revoking"
              ? "Removing agent authority…"
              : "Submitting…"}
        </p>
      ) : null}

      {phase.kind === "running" ? <KillProgress eoa={eoa} killId={phase.killId} /> : null}

      {phase.kind === "error" ? (
        <div className="space-y-6">
          <p role="alert" className="text-small">
            {phase.message}
          </p>
          <KillHold onConfirmed={start} />
        </div>
      ) : null}
    </main>
  );
}
