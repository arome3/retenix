import type { PolicyDraft } from "@retenix/shared";
import { describe, expect, it } from "vitest";
import {
  clampDraft,
  explicitPcts,
  normalizePcts,
  postProcessDraft,
  resolveParse,
} from "./draft";

const OPTS_DE = { region: "DE", utterance: "mostly S&P, some Tesla" };

const brokerDraft = (
  basket: { assetId: string; pct: number }[],
  over: Partial<NonNullable<PolicyDraft["broker"]>> = {},
): PolicyDraft => ({
  broker: { cadence: "weekly", amountUsd: 25, basket, ...over },
});

describe("normalizePcts (guardrail 4 — proportional + largest remainder)", () => {
  it("resolves the doc-09 worked example: 60/30/20 → 55/27/18 (sums exactly 100)", () => {
    const out = normalizePcts([60, 30, 20]);
    expect(out).toEqual([55, 27, 18]);
    expect(out.reduce((s, v) => s + v, 0)).toBe(100);
  });

  it("leaves an exact-100 basket untouched", () => {
    expect(normalizePcts([60, 30, 10])).toEqual([60, 30, 10]);
  });

  it("normalizes a single leg to [100]", () => {
    expect(normalizePcts([40])).toEqual([100]);
  });

  it("breaks remainder ties by earlier index (deterministic)", () => {
    expect(normalizePcts([1, 1, 1])).toEqual([34, 33, 33]);
    expect(normalizePcts([25, 25, 25, 25])).toEqual([25, 25, 25, 25]);
  });

  it("always sums to exactly 100 across awkward inputs", () => {
    for (const input of [
      [7, 7, 7],
      [1, 2, 3, 4, 5],
      [99.5, 0.5],
      [12.5, 12.5, 75],
    ]) {
      expect(normalizePcts(input).reduce((s, v) => s + v, 0)).toBe(100);
    }
  });
});

describe("explicitPcts (PS-10.7 footer detection)", () => {
  it("extracts % and 'percent' figures", () => {
    expect(
      explicitPcts("60% SPYx, 30% TSLAx and 10 percent SOL"),
    ).toEqual(new Set([60, 30, 10]));
  });

  it("finds nothing in a vague allocation", () => {
    expect(explicitPcts("mostly S&P, some Tesla").size).toBe(0);
  });

  it("does not treat bare dollar figures as percentages", () => {
    expect(explicitPcts("Invest $25 every week").size).toBe(0);
  });
});

describe("clampDraft (guardrail 2, belt-and-suspenders)", () => {
  it("clamps every bound back into range", () => {
    const clamped = clampDraft({
      broker: {
        cadence: "weekly",
        amountUsd: 1200,
        basket: [{ assetId: "sol", pct: 100 }],
      },
      guardian: { maxDrawdownPct: 95, weeklyCapUsd: 6000 },
      legacy: { beneficiaryEmail: " ada@example.com ", inactivityDays: 20 },
    });
    expect(clamped.broker?.amountUsd).toBe(1000);
    expect(clamped.guardian).toEqual({ maxDrawdownPct: 90, weeklyCapUsd: 5000 });
    expect(clamped.legacy).toEqual({
      beneficiaryEmail: "ada@example.com",
      inactivityDays: 30,
    });
  });

  it("clamps inactivityDays down to 3650 and drawdown up to 1", () => {
    const clamped = clampDraft({
      guardian: { maxDrawdownPct: 0.2 },
      legacy: { beneficiaryEmail: "a@b.co", inactivityDays: 9999 },
    });
    expect(clamped.guardian?.maxDrawdownPct).toBe(1);
    expect(clamped.legacy?.inactivityDays).toBe(3650);
  });

  it("drops a guardian with nothing left and a broker with no legs", () => {
    const clamped = clampDraft({
      broker: { cadence: "daily", amountUsd: 10, basket: [] },
      guardian: { weeklyCapUsd: -5 },
    });
    expect(clamped.broker).toBeUndefined();
    expect(clamped.guardian).toBeUndefined();
  });
});

describe("postProcessDraft", () => {
  it("US user + SPYx → asset omitted from the draft, rest re-normalized (doc 04)", () => {
    const post = postProcessDraft(
      brokerDraft([
        { assetId: "spyx", pct: 60 },
        { assetId: "sol", pct: 40 },
      ]),
      { region: "US", utterance: "60% SPYx and 40% SOL, $25 a week" },
    );
    expect(post).not.toBeNull();
    expect(post?.draft.broker?.basket).toEqual([{ assetId: "sol", pct: 100 }]);
    expect(post?.droppedAssetIds).toEqual(["spyx"]);
    // The numbers changed under the user → the footer must ride along.
    expect(post?.adviceFooter).toBe(true);
  });

  it("US user + equity-only basket → nothing remains → null (decline upstream)", () => {
    const post = postProcessDraft(
      brokerDraft([{ assetId: "spyx", pct: 100 }]),
      { region: "US", utterance: "all in on SPYx" },
    );
    expect(post).toBeNull();
  });

  it("merges duplicate legs in first-occurrence order (order is load-bearing, doc 08)", () => {
    const post = postProcessDraft(
      brokerDraft([
        { assetId: "spyx", pct: 50 },
        { assetId: "sol", pct: 40 },
        { assetId: "spyx", pct: 10 },
      ]),
      OPTS_DE,
    );
    expect(post?.draft.broker?.basket).toEqual([
      { assetId: "spyx", pct: 60 },
      { assetId: "sol", pct: 40 },
    ]);
  });

  it("drops zero-pct legs before normalizing", () => {
    const post = postProcessDraft(
      brokerDraft([
        { assetId: "spyx", pct: 0 },
        { assetId: "sol", pct: 50 },
      ]),
      OPTS_DE,
    );
    expect(post?.draft.broker?.basket).toEqual([{ assetId: "sol", pct: 100 }]);
  });

  it("drops a leg that rounds to 0% and re-normalizes the rest", () => {
    const post = postProcessDraft(
      brokerDraft([
        { assetId: "spyx", pct: 999 },
        { assetId: "sol", pct: 1 },
      ]),
      OPTS_DE,
    );
    expect(post?.draft.broker?.basket).toEqual([{ assetId: "spyx", pct: 100 }]);
  });

  it("keeps guardian/legacy when the basket empties out", () => {
    const post = postProcessDraft(
      {
        ...brokerDraft([{ assetId: "spyx", pct: 100 }]),
        guardian: { maxDrawdownPct: 15 },
      },
      { region: "US", utterance: "SPYx, stop at 15%" },
    );
    expect(post?.draft.broker).toBeUndefined();
    expect(post?.draft.guardian).toEqual({ maxDrawdownPct: 15 });
  });

  it("returns null for an all-empty draft", () => {
    expect(postProcessDraft({}, OPTS_DE)).toBeNull();
  });

  it("leaves the advice footer OFF when the user stated every final percentage", () => {
    const post = postProcessDraft(
      brokerDraft([
        { assetId: "spyx", pct: 60 },
        { assetId: "tslax", pct: 30 },
        { assetId: "sol", pct: 10 },
      ]),
      {
        region: "DE",
        utterance: "Invest $25 every week: 60% SPYx, 30% TSLAx, 10% SOL.",
      },
    );
    expect(post?.adviceFooter).toBe(false);
  });

  it("turns the footer ON when re-normalization changed the user's numbers", () => {
    const post = postProcessDraft(
      brokerDraft([
        { assetId: "spyx", pct: 60 },
        { assetId: "tslax", pct: 30 },
        { assetId: "sol", pct: 20 },
      ]),
      {
        region: "DE",
        utterance: "60% SPYx, 30% TSLAx, 20% SOL every week", // sums 110
      },
    );
    expect(post?.draft.broker?.basket.map((l) => l.pct)).toEqual([55, 27, 18]);
    expect(post?.adviceFooter).toBe(true);
  });
});

describe("resolveParse (the single route/eval pipeline)", () => {
  it("maps a valid output to a normalized draft", () => {
    const resolved = resolveParse(
      { kind: "output", raw: brokerDraft([{ assetId: "sol", pct: 100 }]) },
      { region: "US", utterance: "put $25 a week into SOL" },
    );
    expect(resolved.kind).toBe("draft");
  });

  it("maps {} to the canonical graceful decline, copy verbatim", () => {
    const resolved = resolveParse(
      { kind: "output", raw: {} },
      { region: "DE", utterance: "what's the weather" },
    );
    expect(resolved).toMatchObject({
      kind: "decline",
      cause: "empty",
    });
    if (resolved.kind === "decline") {
      expect(resolved.decline.message).toBe(
        "I didn't want to guess. Try: 'Invest $25 weekly into SPYx and SOL, stop if I'm down 15%.'",
      );
      expect(resolved.decline.suggestions.length).toBeGreaterThan(0);
    }
  });

  it("suggestions never name an equity for a blocked region", () => {
    const resolved = resolveParse(
      { kind: "output", raw: {} },
      { region: "US", utterance: "hmm" },
    );
    expect(resolved.kind).toBe("decline");
    if (resolved.kind === "decline") {
      for (const s of resolved.decline.suggestions) {
        expect(s).not.toMatch(/SPYx|TSLAx|QQQx|AAPLx|NVDAx/);
      }
    }
  });

  it("treats schema-invalid raw output as no-object (graceful re-prompt)", () => {
    const resolved = resolveParse(
      {
        kind: "output",
        raw: brokerDraft([{ assetId: "sol", pct: 100 }], { amountUsd: 2000 }),
      },
      { region: "DE", utterance: "x" },
    );
    expect(resolved).toMatchObject({ kind: "decline", cause: "no-object" });
  });

  it("maps no-object and unavailable to their decline copy — never a throw", () => {
    const noObject = resolveParse({ kind: "no-object" }, OPTS_DE);
    expect(noObject).toMatchObject({ kind: "decline", cause: "no-object" });

    const unavailable = resolveParse({ kind: "unavailable" }, OPTS_DE);
    expect(unavailable).toMatchObject({
      kind: "decline",
      cause: "unavailable",
    });
    if (unavailable.kind === "decline") {
      expect(unavailable.decline.message).toContain("build it by hand");
    }
  });

  it("rejects a non-registry asset outright (G11 — the enum is the firewall)", () => {
    const resolved = resolveParse(
      { kind: "output", raw: brokerDraft([{ assetId: "pepe", pct: 100 }]) },
      OPTS_DE,
    );
    expect(resolved).toMatchObject({ kind: "decline", cause: "no-object" });
  });
});
