import { describe, expect, it } from "vitest";
import {
  type AssetEligibility,
  COMPLIANCE_QUIZ,
  EQUITY_RESTRICTED_REGIONS,
  isAssetEligibleInRegion,
  isEquityEligible,
  isGatePassed,
  isLeverageUnlocked,
  isQuizAllCorrect,
  isSanctioned,
  isValidRegion,
  LEVERAGE_QUIZ_ID,
  SANCTIONED_REGIONS,
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

describe("RWA-gold eligibility (NON_SANCTIONED tier, doc 20 / OQ-R2)", () => {
  // A three-class stand-in: equity (NON_RESTRICTED), crypto (ALL), gold
  // (NON_SANCTIONED). Proves the US-fallback upgrade — a US user sees gold +
  // crypto but NOT equities — while sanctioned regions get neither gold nor equities.
  const REGISTRY: { sym: string; eligibleRegions: AssetEligibility }[] = [
    { sym: "SPYx", eligibleRegions: "NON_RESTRICTED" },
    { sym: "SOL", eligibleRegions: "ALL" },
    { sym: "ETH", eligibleRegions: "ALL" },
    { sym: "PAXG", eligibleRegions: "NON_SANCTIONED" },
  ];
  const eligibleAssets = (region: string) =>
    REGISTRY.filter((a) => isAssetEligibleInRegion(a.eligibleRegions, region)).map(
      (a) => a.sym,
    );

  it("the sanctioned set is exactly the proposed four (owner reviews the final list)", () => {
    expect([...SANCTIONED_REGIONS]).toEqual(["CU", "IR", "KP", "SY"]);
  });

  it("isSanctioned matches the set and nothing else", () => {
    for (const r of ["CU", "IR", "KP", "SY"]) expect(isSanctioned(r)).toBe(true);
    for (const r of ["US", "CA", "GB", "AU", "DE", "NG", ""])
      expect(isSanctioned(r)).toBe(false);
  });

  it("a US user sees gold + crypto but NEVER an equity (the fallback upgrade)", () => {
    expect(eligibleAssets("US")).toEqual(["SOL", "ETH", "PAXG"]);
    // The equity block list is unchanged — gold does not soften it.
    expect(eligibleAssets("US")).not.toContain("SPYx");
  });

  it("a non-restricted region sees all three classes", () => {
    expect(eligibleAssets("DE")).toEqual(["SPYx", "SOL", "ETH", "PAXG"]);
  });

  it("gold (and ONLY gold) is withheld in a sanctioned region", () => {
    // Honest composed behavior to flag for the compliance owner: equities ride
    // the SEPARATE 4-country NON_RESTRICTED list (US/CA/GB/AU), so a sanctioned
    // region that is not one of those four still sees equities — only the
    // NON_SANCTIONED (gold) tier withholds here. Whether equities should ALSO be
    // sanction-gated is a doc-04 decision, out of module 20's scope.
    for (const region of ["IR", "KP", "CU", "SY"]) {
      expect(eligibleAssets(region)).not.toContain("PAXG");
      expect(eligibleAssets(region)).toContain("SOL"); // crypto floor unaffected
    }
  });

  it("gold is independent of the equity block — US (equity-blocked) still gets it", () => {
    // NON_SANCTIONED ignores EQUITY_RESTRICTED_REGIONS entirely.
    expect(isAssetEligibleInRegion("NON_SANCTIONED", "US")).toBe(true);
    expect(isAssetEligibleInRegion("NON_RESTRICTED", "US")).toBe(false);
  });
});

describe("appropriateness quiz", () => {
  it("has four questions, each with exactly one correct option", () => {
    // 3 → 4 with doc 18 F11's leverage/decay question.
    expect(COMPLIANCE_QUIZ).toHaveLength(4);
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
    // Arities RE-BASED for the 4-question quiz. [0,0,0,0] used to be a
    // length failure and is now the all-correct answer (every correct option
    // sits at index 0), so testing it here would silently invert the test's
    // meaning — the too-long case moved to length 5.
    expect(isQuizAllCorrect([0, 0])).toBe(false);
    expect(isQuizAllCorrect([0, 0, 0, 0, 0])).toBe(false);
    expect(isQuizAllCorrect([9, 9, 9, 9])).toBe(false);
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

  it("Q4 (doc 18 F11) teaches daily-reset decay without using the word 'leverage'", () => {
    const q4 = COMPLIANCE_QUIZ[3];
    expect(q4.id).toBe(LEVERAGE_QUIZ_ID);
    expect(q4.options.find((o) => o.correct)?.text).toBe(
      "No — it resets daily, so over time the result drifts from double, and choppy markets erode it.",
    );
    // G12: "leverage" is reserved for the F12 compliance surface. A concrete
    // "2× token" is both plainer and inside the vocabulary rules.
    expect(`${q4.prompt} ${q4.options.map((o) => o.text).join(" ")} ${q4.explanation}`)
      .not.toMatch(/\blever(age|aged|aging)\b/i);
  });
});

describe("leverage unlock (doc 18 F11)", () => {
  const correctIndices = () =>
    COMPLIANCE_QUIZ.map((q) => q.options.findIndex((o) => o.correct));

  it("unlocks only when the current quiz — including Q4 — is fully answered", () => {
    expect(isLeverageUnlocked(correctIndices())).toBe(true);
  });

  it("GRANDFATHERS pre-F11 users: a stored 3-answer row does NOT unlock", () => {
    // The whole migration story. A user who passed the old 3-question quiz
    // keeps their region and all non-leveraged access; they simply cannot see
    // a 3× token until they have been asked the decay question.
    expect(isLeverageUnlocked([0, 0, 0])).toBe(false);
  });

  it("rejects junk payloads rather than throwing (events.payload_json is jsonb)", () => {
    for (const junk of [null, undefined, "0,0,0,0", {}, [0, "1", 0, 0], [], 4]) {
      expect(isLeverageUnlocked(junk)).toBe(false);
    }
  });

  it("a wrong answer to Q4 alone withholds the unlock", () => {
    const answers = correctIndices();
    answers[3] = COMPLIANCE_QUIZ[3].options.findIndex((o) => !o.correct);
    expect(isLeverageUnlocked(answers)).toBe(false);
  });
});
