"use client";

// C3 · PolicyCard (doc 10 task 1) — the readable, signable, revocable face of
// every policy. The signature component: nothing activates from a draft card
// without a signature (PS-F3.2). Every card carries the Revoke button and the
// "Can never" panel — a variant without them is a spec violation (PS-4.4).
//
// States (doc 10 / DS §7):
//   draft   — dashed border, pre-signature
//   active  — teal left rule
//   paused  — muted
//   blocked — amber pulse when a guardian block receipt arrives (reduced-motion
//             collapses to a ≤150ms fade)
//   revoked — struck through
//
// Card states use teal/amber/muted, never gain/loss colors (G14/G15). Success
// is a subtle teal check, never celebration.
import type { ReactNode } from "react";
import {
  BrokerAvatar,
  ContinuityAvatar,
  GuardianAvatar,
} from "@/components/avatars";
import { CanNeverPanel } from "@/components/CanNeverPanel";
import { Num } from "@/components/Num";
import type { PolicyTerm } from "@/lib/policy-terms";

export type PolicyCardKind = "broker" | "guardian" | "legacy";
export type PolicyCardState =
  | "draft"
  | "active"
  | "paused"
  | "blocked"
  | "revoked";

export interface PolicyCardProps {
  kind: PolicyCardKind;
  state: PolicyCardState;
  /** The user's own words, quoted (display-only — never the term source). */
  title: string;
  /** Plain terms rendered from the validated draft/params. */
  terms: PolicyTerm[];
  /** The autonomy dial (broker cards) or any extra body (rendered above Can-never). */
  children?: ReactNode;
  /** Footer actions — omit any the state doesn't allow. */
  onEdit?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onRevoke?: () => void;
  /** "Not investment advice" footer (PS-10.7) — model-proposed baskets only. */
  adviceFooter?: boolean;
}

const AVATAR: Record<PolicyCardKind, typeof BrokerAvatar> = {
  broker: BrokerAvatar,
  guardian: GuardianAvatar,
  legacy: ContinuityAvatar,
};

const CAN_NEVER: Record<PolicyCardKind, "broker" | "guardian" | "legacy"> = {
  broker: "broker",
  guardian: "guardian",
  legacy: "legacy",
};

function stateClasses(state: PolicyCardState): string {
  switch (state) {
    case "draft":
      return "border-dashed border-border";
    case "active":
      return "border-border border-l-2 border-l-[var(--color-agent)]";
    case "paused":
      return "border-border opacity-70";
    case "blocked":
      // amber pulse; reduced-motion collapses to a fade (globals.css zeroes
      // animation-duration under prefers-reduced-motion, and data-rm-fade
      // gives a ≤150ms opacity fade instead).
      return "border-warning animate-[pulse_1s_ease-in-out_2] [--tw-ring-color:var(--color-warning)]";
    case "revoked":
      return "border-border opacity-60";
  }
}

const STATE_LABEL: Record<PolicyCardState, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  blocked: "Blocked something",
  revoked: "Revoked",
};

export function PolicyCard(props: PolicyCardProps) {
  const Avatar = AVATAR[props.kind];
  const struck = props.state === "revoked";

  return (
    <article
      data-rm-fade={props.state === "blocked" ? "" : undefined}
      className={`flex flex-col gap-3 rounded-lg border bg-card p-4 ${stateClasses(props.state)}`}
      aria-label={`${props.kind} policy — ${STATE_LABEL[props.state]}`}
    >
      <header className="flex items-start gap-3">
        <Avatar size={40} />
        <div className="flex min-w-0 flex-1 flex-col">
          <h3
            className={`text-h2 font-display ${struck ? "line-through" : ""}`}
          >
            “{props.title}”
          </h3>
          <span className="text-caption text-muted-foreground">
            {STATE_LABEL[props.state]}
          </span>
        </div>
      </header>

      <ul className={`flex flex-col gap-1 ${struck ? "line-through" : ""}`}>
        {props.terms.map((t, i) => (
          <li key={`${t.text}-${i}`} className="text-small text-foreground">
            {t.text}
            {t.value !== undefined && (
              <>
                {" "}
                <Num className="font-medium">{t.value}</Num>
              </>
            )}
          </li>
        ))}
      </ul>

      {props.children}

      <CanNeverPanel variant={CAN_NEVER[props.kind]} />

      {props.adviceFooter && (
        <p className="text-caption text-muted-foreground">
          Suggested allocation — not investment advice.
        </p>
      )}

      <footer className="flex flex-wrap gap-4 pt-1 text-small">
        {props.onEdit && props.state !== "revoked" && (
          <button
            type="button"
            onClick={props.onEdit}
            className="min-h-6 text-agent"
          >
            Edit
          </button>
        )}
        {props.onPause && props.state === "active" && (
          <button
            type="button"
            onClick={props.onPause}
            className="min-h-6 text-muted-foreground"
          >
            Pause
          </button>
        )}
        {props.onResume && props.state === "paused" && (
          <button
            type="button"
            onClick={props.onResume}
            className="min-h-6 text-agent"
          >
            Resume
          </button>
        )}
        {props.onRevoke && props.state !== "revoked" && (
          <button
            type="button"
            onClick={props.onRevoke}
            className="min-h-6 text-destructive"
          >
            Revoke
          </button>
        )}
      </footer>
    </article>
  );
}
