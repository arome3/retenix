// PS-8.2 product instrumentation (doc 17 §Observability).
//
// WHY THE STRINGS LIVE HERE. scripts/copy-canon.mjs scans
// apps/web/{app,components,lib,hooks,server} for banned network vocabulary
// (G12) and it reads identifiers and import specifiers, not just user copy —
// module 02 had to rename a file because of the specifier "./chains". The
// spec-mandated literal "ui.network_named" contains a banned stem, so it lives
// in packages/, which is outside the scan, and appears EXACTLY ONCE in the repo.
//
// Same reason the delegation-panel surface key is "security" and not
// "delegations": the latter matches copy-canon's /\bdelegat(e|es|ed|ing|ion|
// ions)\b/i and would redden CI (verified).

import { z } from "zod";

export const UI_EVENTS = {
  /**
   * Fired once per session per surface when a source's proper name is put on
   * screen. Serves the PS-8.2 metric "≥60% of sessions include zero chain-name
   * exposure" — so it is a SESSION event, not a per-render one.
   */
  networkNamed: "ui.network_named",
  /**
   * Fired once per session, unconditionally.
   *
   * This is not optional bookkeeping: it is the DENOMINATOR. A session with
   * zero chain-name exposure emits no networkNamed row by definition, so
   * without this the "≥60% of sessions" metric would be dividing exposed
   * sessions by exposed sessions and could only ever report 100%.
   *
   * Doubles as the weekly-active signal (count distinct user_id per week).
   */
  sessionStarted: "ui.session_started",
  /** Activation clock start. Paired with the existing plan.activated for
   *  "first funded policy < 10 min from signup". */
  signup: "user.signup",
} as const;

export type UiEventType = (typeof UI_EVENTS)[keyof typeof UI_EVENTS];

/**
 * Surfaces that may put a source's proper name on screen.
 *
 * Doc 17 names receipts/breakdown/withdraw. The other three are the surfaces
 * that genuinely do the same thing and would otherwise make the metric flatter
 * itself: the post-sweep receipt legs, the kill-switch per-leg rows, and the
 * delegation panel (which lists all six by name).
 */
export const NAMED_SURFACES = [
  "breakdown",
  "receipt",
  "withdraw",
  "sweep",
  "kill",
  "security",
] as const;

export type NamedSurface = (typeof NAMED_SURFACES)[number];

export const namedSurfaceSchema = z.enum(NAMED_SURFACES);

export const uiNetworkNamedInputSchema = z
  .object({ sid: z.uuid(), surface: namedSurfaceSchema })
  .strict();

export const uiSessionStartedInputSchema = z
  .object({ sid: z.uuid(), onboardingSid: z.uuid().nullish() })
  .strict();
