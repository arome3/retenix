/*
 * The region model (doc 04) — the single contract every asset surface consumes.
 *
 * This module is the ONE place tokenized-equity eligibility is decided. Module 05's
 * `eligibleAssets(region)` imports `AssetEligibility` and `isAssetEligibleInRegion`
 * from here rather than re-deriving the rule; a second, ad-hoc filter would drift
 * (that is how "a US user sees SPYx in search" bugs happen). Framework-free on
 * purpose — @retenix/shared is imported by both the web app and the worker, so this
 * carries no React, no DB, no next/* imports.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Restricted set + eligibility
// ---------------------------------------------------------------------------

/**
 * Regions where tokenized EQUITIES are blocked (Kraken/Bybit self-serve pattern).
 * The product spec names US/CA/UK/AU; UK = ISO 3166-1 alpha-2 `GB`. Defined ONCE,
 * here — never copied. Crypto (SOL/ETH) is never restricted, so a blocked region
 * still gets a working product (the crypto-basket experience), not a rejection.
 */
export const EQUITY_RESTRICTED_REGIONS = ["US", "CA", "GB", "AU"] as const;
export type EquityRestrictedRegion = (typeof EQUITY_RESTRICTED_REGIONS)[number];

/** false iff the region blocks tokenized equities. */
export function isEquityEligible(region: string): boolean {
  return !(EQUITY_RESTRICTED_REGIONS as readonly string[]).includes(region);
}

/**
 * A registry entry's regional availability. Equities carry "NON_RESTRICTED";
 * SOL/ETH (and any always-available asset) carry "ALL". Exported so module 05's
 * registry types import this union rather than redeclaring it.
 */
export type AssetEligibility = "ALL" | "NON_RESTRICTED";

/**
 * The verbatim filter semantics module 05 applies, as a helper:
 *   REGISTRY.filter(a => isAssetEligibleInRegion(a.eligibleRegions, region))
 * === REGISTRY.filter(a => a.eligibleRegions === "ALL" || !EQUITY_RESTRICTED_REGIONS.includes(region))
 */
export function isAssetEligibleInRegion(
  eligibility: AssetEligibility,
  region: string,
): boolean {
  return eligibility === "ALL" || isEquityEligible(region);
}

// ---------------------------------------------------------------------------
// Gate-status derivation (no separate flag to drift)
// ---------------------------------------------------------------------------

/**
 * The spec's gate-status formula: gatePassed = region != null && quizPassed && riskAck.
 *
 * In this codebase `users.region` is written "" until the gate is *complete* — the
 * column is set atomically at the final risk-acknowledgment step, after the quiz and
 * region-pick events already exist (doc 04). So in practice `region !== ""` already
 * implies all three; this helper spells the derivation out for the truth-table test
 * and for any caller that has the raw events in hand.
 */
export function isGatePassed(
  region: string | null | undefined,
  events: { quizPassed: boolean; riskAcknowledged: boolean },
): boolean {
  return Boolean(region) && events.quizPassed && events.riskAcknowledged;
}

// ---------------------------------------------------------------------------
// Audit event types (the four gate artifacts land in `events.type`)
// ---------------------------------------------------------------------------

export const COMPLIANCE_EVENTS = {
  regionSet: "compliance.region_set",
  quizPassed: "compliance.quiz_passed",
  identitySimulated: "compliance.identity_simulated",
  riskAcknowledged: "compliance.risk_acknowledged",
} as const;

export type ComplianceEventType =
  (typeof COMPLIANCE_EVENTS)[keyof typeof COMPLIANCE_EVENTS];

// ---------------------------------------------------------------------------
// Appropriateness quiz — one source for client rendering AND server validation
// ---------------------------------------------------------------------------

/*
 * PROPOSED (spec-silent copy, awaiting product sign-off before W3 UI freeze —
 * cross-check vs kraken.com/legal/xstocks + Robinhood EU). The correct-answer
 * text of each question is verbatim from doc 04; the distractor option and the
 * amber teaching explanation are authored here (doc 04 gives none).
 *
 * The quiz is appropriateness, not authentication (WCAG 3.3.8 stays clear), so a
 * client-visible answer key is fine — `compliance.submitQuiz` re-validates every
 * answer against this same array server-side. Options render in canonical order
 * (no shuffle) so the submitted index maps straight back here.
 */
export type QuizOption = { text: string; correct: boolean };
export type QuizQuestion = {
  id: number;
  prompt: string;
  options: QuizOption[];
  /** Shown (amber) when a wrong option is tapped — teaching, not failing. */
  explanation: string;
};

export const COMPLIANCE_QUIZ: readonly QuizQuestion[] = [
  {
    id: 1,
    prompt: "If you hold TSLAx, do you own Tesla shares?",
    options: [
      {
        text: "No — it's a token that tracks the price. No voting rights or dividend claims.",
        correct: true,
      },
      {
        text: "Yes — holding TSLAx is the same as owning Tesla stock.",
        correct: false,
      },
    ],
    explanation:
      "Not quite. TSLAx is a token that tracks Tesla's price — holding it doesn't give you shares, voting rights, or dividend claims.",
  },
  {
    id: 2,
    prompt: "Can the value of a tokenized stock go to zero?",
    options: [
      {
        text: "Yes — like any investment, and it also depends on the issuer.",
        correct: true,
      },
      {
        text: "No — a tokenized stock is protected from losing all its value.",
        correct: false,
      },
    ],
    explanation:
      "It can. Like any investment its value can fall to zero — and it also carries the issuer's risk.",
  },
  {
    id: 3,
    prompt: "When can tokenized stock prices move?",
    options: [
      {
        text: "Around the clock — including when the stock market is closed, when prices can move more sharply.",
        correct: true,
      },
      { text: "Only during normal stock-market opening hours.", correct: false },
    ],
    explanation:
      "Prices can move around the clock — including when the stock market is closed, when moves can be sharper.",
  },
] as const;

/** True iff every question's selected option index is the correct one. */
export function isQuizAllCorrect(answers: number[]): boolean {
  if (answers.length !== COMPLIANCE_QUIZ.length) return false;
  return COMPLIANCE_QUIZ.every((q, i) => q.options[answers[i]]?.correct === true);
}

/** Input schema for `compliance.submitQuiz` — one option index per question. */
export const quizAnswersSchema = z
  .array(z.number().int().nonnegative())
  .length(COMPLIANCE_QUIZ.length);

// ---------------------------------------------------------------------------
// Countries — full ISO 3166-1 alpha-2 list (region is self-attested; no geo-IP
// in v1). One canonical list: the region <Select> renders it and `isValidRegion`
// derives from it, so `setRegion` can reject a non-ISO code (denylist evasion).
// ---------------------------------------------------------------------------

export type Country = { code: string; name: string };

export const COUNTRIES: readonly Country[] = [
  { code: "AF", name: "Afghanistan" },
  { code: "AX", name: "Åland Islands" },
  { code: "AL", name: "Albania" },
  { code: "DZ", name: "Algeria" },
  { code: "AS", name: "American Samoa" },
  { code: "AD", name: "Andorra" },
  { code: "AO", name: "Angola" },
  { code: "AI", name: "Anguilla" },
  { code: "AQ", name: "Antarctica" },
  { code: "AG", name: "Antigua and Barbuda" },
  { code: "AR", name: "Argentina" },
  { code: "AM", name: "Armenia" },
  { code: "AW", name: "Aruba" },
  { code: "AU", name: "Australia" },
  { code: "AT", name: "Austria" },
  { code: "AZ", name: "Azerbaijan" },
  { code: "BS", name: "Bahamas" },
  { code: "BH", name: "Bahrain" },
  { code: "BD", name: "Bangladesh" },
  { code: "BB", name: "Barbados" },
  { code: "BY", name: "Belarus" },
  { code: "BE", name: "Belgium" },
  { code: "BZ", name: "Belize" },
  { code: "BJ", name: "Benin" },
  { code: "BM", name: "Bermuda" },
  { code: "BT", name: "Bhutan" },
  { code: "BO", name: "Bolivia" },
  { code: "BQ", name: "Bonaire, Sint Eustatius and Saba" },
  { code: "BA", name: "Bosnia and Herzegovina" },
  { code: "BW", name: "Botswana" },
  { code: "BV", name: "Bouvet Island" },
  { code: "BR", name: "Brazil" },
  { code: "IO", name: "British Indian Ocean Territory" },
  { code: "BN", name: "Brunei Darussalam" },
  { code: "BG", name: "Bulgaria" },
  { code: "BF", name: "Burkina Faso" },
  { code: "BI", name: "Burundi" },
  { code: "CV", name: "Cabo Verde" },
  { code: "KH", name: "Cambodia" },
  { code: "CM", name: "Cameroon" },
  { code: "CA", name: "Canada" },
  { code: "KY", name: "Cayman Islands" },
  { code: "CF", name: "Central African Republic" },
  { code: "TD", name: "Chad" },
  { code: "CL", name: "Chile" },
  { code: "CN", name: "China" },
  { code: "CX", name: "Christmas Island" },
  { code: "CC", name: "Cocos (Keeling) Islands" },
  { code: "CO", name: "Colombia" },
  { code: "KM", name: "Comoros" },
  { code: "CG", name: "Congo" },
  { code: "CD", name: "Congo (Democratic Republic)" },
  { code: "CK", name: "Cook Islands" },
  { code: "CR", name: "Costa Rica" },
  { code: "CI", name: "Côte d'Ivoire" },
  { code: "HR", name: "Croatia" },
  { code: "CU", name: "Cuba" },
  { code: "CW", name: "Curaçao" },
  { code: "CY", name: "Cyprus" },
  { code: "CZ", name: "Czechia" },
  { code: "DK", name: "Denmark" },
  { code: "DJ", name: "Djibouti" },
  { code: "DM", name: "Dominica" },
  { code: "DO", name: "Dominican Republic" },
  { code: "EC", name: "Ecuador" },
  { code: "EG", name: "Egypt" },
  { code: "SV", name: "El Salvador" },
  { code: "GQ", name: "Equatorial Guinea" },
  { code: "ER", name: "Eritrea" },
  { code: "EE", name: "Estonia" },
  { code: "SZ", name: "Eswatini" },
  { code: "ET", name: "Ethiopia" },
  { code: "FK", name: "Falkland Islands" },
  { code: "FO", name: "Faroe Islands" },
  { code: "FJ", name: "Fiji" },
  { code: "FI", name: "Finland" },
  { code: "FR", name: "France" },
  { code: "GF", name: "French Guiana" },
  { code: "PF", name: "French Polynesia" },
  { code: "TF", name: "French Southern Territories" },
  { code: "GA", name: "Gabon" },
  { code: "GM", name: "Gambia" },
  { code: "GE", name: "Georgia" },
  { code: "DE", name: "Germany" },
  { code: "GH", name: "Ghana" },
  { code: "GI", name: "Gibraltar" },
  { code: "GR", name: "Greece" },
  { code: "GL", name: "Greenland" },
  { code: "GD", name: "Grenada" },
  { code: "GP", name: "Guadeloupe" },
  { code: "GU", name: "Guam" },
  { code: "GT", name: "Guatemala" },
  { code: "GG", name: "Guernsey" },
  { code: "GN", name: "Guinea" },
  { code: "GW", name: "Guinea-Bissau" },
  { code: "GY", name: "Guyana" },
  { code: "HT", name: "Haiti" },
  { code: "HM", name: "Heard Island and McDonald Islands" },
  { code: "VA", name: "Holy See" },
  { code: "HN", name: "Honduras" },
  { code: "HK", name: "Hong Kong" },
  { code: "HU", name: "Hungary" },
  { code: "IS", name: "Iceland" },
  { code: "IN", name: "India" },
  { code: "ID", name: "Indonesia" },
  { code: "IR", name: "Iran" },
  { code: "IQ", name: "Iraq" },
  { code: "IE", name: "Ireland" },
  { code: "IM", name: "Isle of Man" },
  { code: "IL", name: "Israel" },
  { code: "IT", name: "Italy" },
  { code: "JM", name: "Jamaica" },
  { code: "JP", name: "Japan" },
  { code: "JE", name: "Jersey" },
  { code: "JO", name: "Jordan" },
  { code: "KZ", name: "Kazakhstan" },
  { code: "KE", name: "Kenya" },
  { code: "KI", name: "Kiribati" },
  { code: "KP", name: "Korea (North)" },
  { code: "KR", name: "Korea (South)" },
  { code: "KW", name: "Kuwait" },
  { code: "KG", name: "Kyrgyzstan" },
  { code: "LA", name: "Laos" },
  { code: "LV", name: "Latvia" },
  { code: "LB", name: "Lebanon" },
  { code: "LS", name: "Lesotho" },
  { code: "LR", name: "Liberia" },
  { code: "LY", name: "Libya" },
  { code: "LI", name: "Liechtenstein" },
  { code: "LT", name: "Lithuania" },
  { code: "LU", name: "Luxembourg" },
  { code: "MO", name: "Macao" },
  { code: "MG", name: "Madagascar" },
  { code: "MW", name: "Malawi" },
  { code: "MY", name: "Malaysia" },
  { code: "MV", name: "Maldives" },
  { code: "ML", name: "Mali" },
  { code: "MT", name: "Malta" },
  { code: "MH", name: "Marshall Islands" },
  { code: "MQ", name: "Martinique" },
  { code: "MR", name: "Mauritania" },
  { code: "MU", name: "Mauritius" },
  { code: "YT", name: "Mayotte" },
  { code: "MX", name: "Mexico" },
  { code: "FM", name: "Micronesia" },
  { code: "MD", name: "Moldova" },
  { code: "MC", name: "Monaco" },
  { code: "MN", name: "Mongolia" },
  { code: "ME", name: "Montenegro" },
  { code: "MS", name: "Montserrat" },
  { code: "MA", name: "Morocco" },
  { code: "MZ", name: "Mozambique" },
  { code: "MM", name: "Myanmar" },
  { code: "NA", name: "Namibia" },
  { code: "NR", name: "Nauru" },
  { code: "NP", name: "Nepal" },
  { code: "NL", name: "Netherlands" },
  { code: "NC", name: "New Caledonia" },
  { code: "NZ", name: "New Zealand" },
  { code: "NI", name: "Nicaragua" },
  { code: "NE", name: "Niger" },
  { code: "NG", name: "Nigeria" },
  { code: "NU", name: "Niue" },
  { code: "NF", name: "Norfolk Island" },
  { code: "MK", name: "North Macedonia" },
  { code: "MP", name: "Northern Mariana Islands" },
  { code: "NO", name: "Norway" },
  { code: "OM", name: "Oman" },
  { code: "PK", name: "Pakistan" },
  { code: "PW", name: "Palau" },
  { code: "PS", name: "Palestine" },
  { code: "PA", name: "Panama" },
  { code: "PG", name: "Papua New Guinea" },
  { code: "PY", name: "Paraguay" },
  { code: "PE", name: "Peru" },
  { code: "PH", name: "Philippines" },
  { code: "PN", name: "Pitcairn" },
  { code: "PL", name: "Poland" },
  { code: "PT", name: "Portugal" },
  { code: "PR", name: "Puerto Rico" },
  { code: "QA", name: "Qatar" },
  { code: "RE", name: "Réunion" },
  { code: "RO", name: "Romania" },
  { code: "RU", name: "Russia" },
  { code: "RW", name: "Rwanda" },
  { code: "BL", name: "Saint Barthélemy" },
  { code: "SH", name: "Saint Helena, Ascension and Tristan da Cunha" },
  { code: "KN", name: "Saint Kitts and Nevis" },
  { code: "LC", name: "Saint Lucia" },
  { code: "MF", name: "Saint Martin (French part)" },
  { code: "PM", name: "Saint Pierre and Miquelon" },
  { code: "VC", name: "Saint Vincent and the Grenadines" },
  { code: "WS", name: "Samoa" },
  { code: "SM", name: "San Marino" },
  { code: "ST", name: "Sao Tome and Principe" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "SN", name: "Senegal" },
  { code: "RS", name: "Serbia" },
  { code: "SC", name: "Seychelles" },
  { code: "SL", name: "Sierra Leone" },
  { code: "SG", name: "Singapore" },
  { code: "SX", name: "Sint Maarten (Dutch part)" },
  { code: "SK", name: "Slovakia" },
  { code: "SI", name: "Slovenia" },
  { code: "SB", name: "Solomon Islands" },
  { code: "SO", name: "Somalia" },
  { code: "ZA", name: "South Africa" },
  { code: "GS", name: "South Georgia and the South Sandwich Islands" },
  { code: "SS", name: "South Sudan" },
  { code: "ES", name: "Spain" },
  { code: "LK", name: "Sri Lanka" },
  { code: "SD", name: "Sudan" },
  { code: "SR", name: "Suriname" },
  { code: "SJ", name: "Svalbard and Jan Mayen" },
  { code: "SE", name: "Sweden" },
  { code: "CH", name: "Switzerland" },
  { code: "SY", name: "Syria" },
  { code: "TW", name: "Taiwan" },
  { code: "TJ", name: "Tajikistan" },
  { code: "TZ", name: "Tanzania" },
  { code: "TH", name: "Thailand" },
  { code: "TL", name: "Timor-Leste" },
  { code: "TG", name: "Togo" },
  { code: "TK", name: "Tokelau" },
  { code: "TO", name: "Tonga" },
  { code: "TT", name: "Trinidad and Tobago" },
  { code: "TN", name: "Tunisia" },
  { code: "TR", name: "Türkiye" },
  { code: "TM", name: "Turkmenistan" },
  { code: "TC", name: "Turks and Caicos Islands" },
  { code: "TV", name: "Tuvalu" },
  { code: "UG", name: "Uganda" },
  { code: "UA", name: "Ukraine" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "GB", name: "United Kingdom" },
  { code: "US", name: "United States" },
  { code: "UM", name: "United States Minor Outlying Islands" },
  { code: "UY", name: "Uruguay" },
  { code: "UZ", name: "Uzbekistan" },
  { code: "VU", name: "Vanuatu" },
  { code: "VE", name: "Venezuela" },
  { code: "VN", name: "Vietnam" },
  { code: "VG", name: "Virgin Islands (British)" },
  { code: "VI", name: "Virgin Islands (U.S.)" },
  { code: "WF", name: "Wallis and Futuna" },
  { code: "EH", name: "Western Sahara" },
  { code: "YE", name: "Yemen" },
  { code: "ZM", name: "Zambia" },
  { code: "ZW", name: "Zimbabwe" },
] as const;

const VALID_REGION_CODES: ReadonlySet<string> = new Set(
  COUNTRIES.map((c) => c.code),
);

/** True iff `region` is a known ISO 3166-1 alpha-2 code. */
export function isValidRegion(region: string): boolean {
  return VALID_REGION_CODES.has(region);
}

/** Input schema for `compliance.setRegion` — a known ISO alpha-2 code only. */
export const regionSchema = z
  .string()
  .refine(isValidRegion, "unknown region code");
