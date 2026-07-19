import { describe, expect, it } from "vitest";

import { FEED_EVENT_TYPES, eventVariant, namesAKnownSource } from "./feed";
import {
  NAMED_SURFACES,
  UI_EVENTS,
  uiNetworkNamedInputSchema,
  uiSessionStartedInputSchema,
} from "./telemetry";

describe("UI_EVENTS", () => {
  // Golden pin: doc 17 names this string verbatim, and a rename would break a
  // dashboard silently rather than break a build. Same pattern as NETWORK_NAMES.
  it("pins the spec-mandated event type", () => {
    expect(UI_EVENTS.networkNamed).toBe("ui.network_named");
  });

  it("keeps the denominator event distinct from the exposure event", () => {
    expect(UI_EVENTS.sessionStarted).not.toBe(UI_EVENTS.networkNamed);
  });

  // These are instrumentation, not product history. The feed must never show
  // "you looked at a breakdown" as an activity row.
  it("no UI event is renderable in the activity feed", () => {
    for (const type of Object.values(UI_EVENTS)) {
      expect([...FEED_EVENT_TYPES], type).not.toContain(type);
      expect(eventVariant(type), type).toBeNull();
    }
  });
});

describe("NAMED_SURFACES", () => {
  // The guard that stops a future contributor adding "delegations" and
  // reddening CI on a scan whose failure mode is nowhere near this file.
  // scripts/copy-canon.mjs bans /\bdelegat(e|es|ed|ing|ion|ions)\b/i, plus the
  // network vocabulary itself.
  const COPY_CANON_STEMS =
    /\b(?:delegat(?:e|es|ed|ing|ion|ions)|network|networks|chain|chains|gas|bridge|wallet|slippage)\b/i;

  it("every surface key is safe for copy-canon and lowercase-simple", () => {
    for (const surface of NAMED_SURFACES) {
      expect(surface, surface).toMatch(/^[a-z]+$/);
      expect(COPY_CANON_STEMS.test(surface), `${surface} trips copy-canon`).toBe(false);
    }
  });

  it("covers the three doc-17 surfaces by name", () => {
    for (const required of ["breakdown", "receipt", "withdraw"]) {
      expect([...NAMED_SURFACES]).toContain(required);
    }
  });
});

describe("input schemas", () => {
  const sid = "6f1b0a3e-6f9c-4f6a-9b8e-9d0f3a2b1c4d";

  it("accepts a well-formed payload", () => {
    expect(
      uiNetworkNamedInputSchema.parse({ sid, surface: "breakdown" }),
    ).toEqual({ sid, surface: "breakdown" });
  });

  it("rejects an unknown surface", () => {
    expect(() =>
      uiNetworkNamedInputSchema.parse({ sid, surface: "delegations" }),
    ).toThrow();
  });

  it("rejects a non-uuid sid", () => {
    expect(() => uiNetworkNamedInputSchema.parse({ sid: "nope", surface: "receipt" })).toThrow();
  });

  // .strict() is a security control, not tidiness: the events table is read by
  // assertGatePassed for compliance rows, so nothing may smuggle extra keys.
  it("rejects extra keys — no smuggling a type or payload", () => {
    expect(() =>
      uiNetworkNamedInputSchema.parse({
        sid,
        surface: "receipt",
        type: "compliance.quiz_passed",
      }),
    ).toThrow();
    expect(() =>
      uiSessionStartedInputSchema.parse({ sid, userId: "someone-else" }),
    ).toThrow();
  });

  it("allows an absent or null onboardingSid", () => {
    expect(uiSessionStartedInputSchema.parse({ sid }).sid).toBe(sid);
    expect(uiSessionStartedInputSchema.parse({ sid, onboardingSid: null }).sid).toBe(sid);
  });
});

describe("namesAKnownSource", () => {
  it("sees names in a funded-from sentence", () => {
    expect(
      namesAKnownSource(
        "Bought $15.00 of SPYx · funded from Base + Arbitrum · fees $0.14",
      ),
    ).toBe(true);
  });

  // The reason this helper exists: compactSentence only elides names inside a
  // "funded from …" segment, and the estate check-in receipt names a network
  // outside one — in the COMPACT row.
  it("sees the estate check-in receipt, which compactSentence does not elide", () => {
    expect(
      namesAKnownSource(
        "Checked in — your activity on Base kept your inheritance plan current.",
      ),
    ).toBe(true);
  });

  it("sees the unknown-id fallback label", () => {
    expect(namesAKnownSource("funded from Source 999")).toBe(true);
  });

  it("does NOT fire on the compacted form, which names nothing", () => {
    expect(namesAKnownSource("▲ funded from 2 sources")).toBe(false);
  });

  it("does not fire on the no-names fallback sentence", () => {
    expect(namesAKnownSource("Bought $15.00 of SPYx · funded from your balance")).toBe(false);
  });

  // Case sensitivity is what keeps "Base" from matching English prose.
  it("does not false-positive on lowercase English containing a name", () => {
    expect(namesAKnownSource("based on your plan")).toBe(false);
    expect(namesAKnownSource("see the codebase")).toBe(false);
  });
});
