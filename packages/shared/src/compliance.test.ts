import { describe, expect, it } from "vitest";
import {
  type AssetEligibility,
  COMPLIANCE_QUIZ,
  EQUITY_RESTRICTED_REGIONS,
  isAssetEligibleInRegion,
  isEquityEligible,
  isGatePassed,
  isQuizAllCorrect,
  isValidRegion,
} from "./compliance";

describe("isEquityEligible", () => {
  // Spec test plan (doc 04): US/CA/GB/AU restricted, DE/NG eligible.
  it.each([
    ["US", false],
    ["CA", false],
    ["GB", false],
    ["AU", false],
    ["DE", true],
    ["NG", true],
  ] as const)("%s -> %s", (region, expected) => {
    expect(isEquityEligible(region)).toBe(expected);
  });

  it("restricts exactly the four named regions and nothing else", () => {
    expect([...EQUITY_RESTRICTED_REGIONS]).toEqual(["US", "CA", "GB", "AU"]);
  });
});

describe("isValidRegion (self-attested — reject non-ISO codes)", () => {
  it("accepts real ISO 3166-1 alpha-2 codes", () => {
    for (const code of ["US", "CA", "GB", "AU", "DE", "NG", "FR", "JP"]) {
      expect(isValidRegion(code)).toBe(true);
    }
  });

  it("rejects garbage codes that would otherwise default to equity-eligible", () => {
    for (const code of ["ZZ", "XX", "QQ", "", "usa", "U", "USA", "us"]) {
      expect(isValidRegion(code)).toBe(false);
    }
    // The evasion this guards: a bogus code is not in the restricted set, so
    // without validation isEquityEligible("ZZ") is true (equities shown).
    expect(isEquityEligible("ZZ")).toBe(true);
    expect(isValidRegion("ZZ")).toBe(false);
  });
});

describe("gate-status derivation truth table", () => {
  // gatePassed = region != null && quizPassed && riskAck. Only all-true passes.
  const region = "US";
  it.each([
    [region, true, true, true],
    [region, true, false, false],
    [region, false, true, false],
    [region, false, false, false],
    ["", true, true, false],
    ["", true, false, false],
    ["", false, true, false],
    ["", false, false, false],
    [null, true, true, false],
  ] as const)(
    "region=%s quiz=%s risk=%s -> %s",
    (r, quizPassed, riskAcknowledged, expected) => {
      expect(isGatePassed(r, { quizPassed, riskAcknowledged })).toBe(expected);
    },
  );
});

describe("registry filter semantics (the contract module 05 consumes)", () => {
  // Stand-in for the doc-05 registry which does not exist yet: prove the region
  // model filters a mixed registry correctly. equity => NON_RESTRICTED, crypto => ALL.
  const REGISTRY: { sym: string; eligibleRegions: AssetEligibility }[] = [
    { sym: "SPYx", eligibleRegions: "NON_RESTRICTED" },
    { sym: "TSLAx", eligibleRegions: "NON_RESTRICTED" },
    { sym: "SOL", eligibleRegions: "ALL" },
    { sym: "ETH", eligibleRegions: "ALL" },
  ];
  const eligibleAssets = (region: string) =>
    REGISTRY.filter((a) => isAssetEligibleInRegion(a.eligibleRegions, region)).map(
      (a) => a.sym,
    );

  it("a restricted region sees only the crypto basket — no equity asset anywhere", () => {
    for (const region of ["US", "CA", "GB", "AU"]) {
      expect(eligibleAssets(region)).toEqual(["SOL", "ETH"]);
    }
  });

  it("an eligible region sees equities and crypto", () => {
    expect(eligibleAssets("DE")).toEqual(["SPYx", "TSLAx", "SOL", "ETH"]);
    expect(eligibleAssets("NG")).toEqual(["SPYx", "TSLAx", "SOL", "ETH"]);
  });

  it("matches the verbatim filter expression from doc 04", () => {
    const region = "US";
    const verbatim = REGISTRY.filter(
      (a) =>
        a.eligibleRegions === "ALL" ||
        !(EQUITY_RESTRICTED_REGIONS as readonly string[]).includes(region),
    ).map((a) => a.sym);
    expect(eligibleAssets(region)).toEqual(verbatim);
  });
});

describe("appropriateness quiz", () => {
  it("has three questions, each with exactly one correct option", () => {
    expect(COMPLIANCE_QUIZ).toHaveLength(3);
    for (const q of COMPLIANCE_QUIZ) {
      expect(q.options.filter((o) => o.correct)).toHaveLength(1);
      expect(q.options.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("isQuizAllCorrect passes only when every selected option is the correct one", () => {
    const correctIndices = COMPLIANCE_QUIZ.map((q) =>
      q.options.findIndex((o) => o.correct),
    );
    expect(isQuizAllCorrect(correctIndices)).toBe(true);

    // any single wrong answer fails
    for (let i = 0; i < correctIndices.length; i++) {
      const wrong = [...correctIndices];
      wrong[i] = COMPLIANCE_QUIZ[i].options.findIndex((o) => !o.correct);
      expect(isQuizAllCorrect(wrong)).toBe(false);
    }
  });

  it("rejects a malformed answer array (wrong length / out of range)", () => {
    expect(isQuizAllCorrect([0, 0])).toBe(false);
    expect(isQuizAllCorrect([0, 0, 0, 0])).toBe(false);
    expect(isQuizAllCorrect([9, 9, 9])).toBe(false);
  });

  it("keeps the correct-answer text verbatim from doc 04", () => {
    expect(COMPLIANCE_QUIZ[0].options.find((o) => o.correct)?.text).toBe(
      "No — it's a token that tracks the price. No voting rights or dividend claims.",
    );
    expect(COMPLIANCE_QUIZ[1].options.find((o) => o.correct)?.text).toBe(
      "Yes — like any investment, and it also depends on the issuer.",
    );
    expect(COMPLIANCE_QUIZ[2].options.find((o) => o.correct)?.text).toBe(
      "Around the clock — including when the stock market is closed, when prices can move more sharply.",
    );
  });
});
