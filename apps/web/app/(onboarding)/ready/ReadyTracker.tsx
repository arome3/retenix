"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { endOnboarding, readOnboarding } from "@/lib/onboarding";
import { trpc } from "@/lib/trpc";

/*
 * Closes the warm-path timer (PS-F1-AC1). Pairs with the onboarding.started row
 * by sid; both rows carry the server clock, so the measured duration never rests
 * on a browser's idea of the time.
 */
export function ReadyTracker() {
  const router = useRouter();
  const track = trpc.auth.trackOnboarding.useMutation();
  const fired = useRef(false);

  useEffect(() => {
    router.prefetch("/home");
    if (fired.current) return;
    fired.current = true;

    const { sid } = readOnboarding();
    if (!sid) return; // A refresh or a direct visit — nothing to close.
    track.mutate({ step: "ready", sid }, { onSettled: endOnboarding });
  }, [router, track]);

  return null;
}
