"use client";

// Profile client rows (doc 15): the Account identity row, the Accessible
// colors toggle (CVD — doc 01's lib/theme seam, mirrored to an audit event
// via account.setPrefs, closing module 01's registerThemeMirror TODO), and
// the Add to Home Screen re-show (doc 01's IosInstallTeach force/reset seam).
import { useEffect, useRef, useState } from "react";
import { IosInstallTeach, resetInstallTeach } from "@/components/IosInstallTeach";
import { magic } from "@/lib/magic";
import { registerThemeMirror, setCvd, useThemePrefs } from "@/lib/theme";
import { trpcVanilla } from "@/lib/trpc-vanilla";

export function AccountRow({ region }: { region: string }) {
  const [email, setEmail] = useState<string | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    // Magic holds the email — the server stores only its hash (doc 00), so
    // identity display is a client-side read; failure just renders nothing.
    void (async () => {
      try {
        const info = (await magic.user.getInfo()) as { email?: string | null };
        if (info.email) setEmail(info.email);
      } catch {
        // leave it blank — the row is display-only
      }
    })();
  }, []);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3.5">
      <div className="flex flex-col">
        <span className="text-body text-foreground">Account</span>
        <span className="text-small text-muted-foreground">
          {email ?? "Signed in"}
        </span>
      </div>
      {region !== "" && (
        <span className="text-small text-muted-foreground">{region}</span>
      )}
    </div>
  );
}

export function AccessibleColorsRow() {
  const prefs = useThemePrefs();

  // The one live registerThemeMirror consumer (doc 01 → doc 15): every theme
  // change made while this row is mounted lands as a prefs.updated audit row.
  useEffect(() => {
    registerThemeMirror((p) => {
      void trpcVanilla.account.setPrefs.mutate(p).catch(() => {
        // mirror is best-effort — localStorage remains the functional store
      });
    });
    return () => registerThemeMirror(null);
  }, []);

  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-3.5">
      <span className="flex flex-col">
        <span className="text-body text-foreground">Accessible colors</span>
        <span className="text-small text-muted-foreground">
          Blue and orange for gains and losses
        </span>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={prefs.cvd}
        onChange={(e) => setCvd(e.target.checked)}
        className="size-5 accent-primary"
        aria-label="Accessible colors"
      />
    </label>
  );
}

export function InstallTeachRow() {
  const [showing, setShowing] = useState(false);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => {
          resetInstallTeach();
          setShowing(true);
        }}
        className="flex min-h-11 items-center justify-between gap-3 px-4 py-3.5 text-left transition-micro hover:bg-muted"
      >
        <span className="text-body text-foreground">Add to Home Screen</span>
        <span className="text-small text-muted-foreground">Show me how</span>
      </button>
      {showing && (
        <div className="px-4 pb-3">
          <IosInstallTeach force onDismiss={() => setShowing(false)} />
        </div>
      )}
    </div>
  );
}
