// packages/registry/src/assets.ts — the pinned asset universe (doc 05).
//
// SINGLE SOURCE OF TRUTH. Anything not in REGISTRY does not exist to Retenix:
// the intent schema (doc 09) enums REGISTRY_IDS, the worker preflight (doc 08)
// rejects unknown assets, and the contract allowlist hash (doc 07) is computed
// from these ids alone. Never add a second source of asset truth anywhere — the
// golden test (assets.golden.test.ts) is the only sanctioned second copy.
//
// ⚠️  FAKE-MINT HAZARD (G11): xStocks SPL mints share the `Xs` vanity prefix and
//     FAKES CIRCULATE. Addresses below are copied verbatim from tech spec §3 /
//     doc 05 — DO NOT retype by hand, and DO NOT edit without re-running the
//     mint-verification procedure (≥2 independent sources) + a G2-style buy on
//     the changed mint. A registry PR that changes any address MUST re-run that
//     procedure. The `Xs` prefix (validate.ts) is only a tripwire; this pinned
//     list is the real defense.
import { validateRegistry } from "./validate";

export type AssetKind = "equity" | "crypto";
export interface RegistryAsset {
  id: string; // REGISTRY_IDS member; lowercase ticker
  ticker: string; // display: "SPYx"
  name: string; // "S&P 500 (tokenized)"
  kind: AssetKind;
  chainId: number; // CHAIN_ID values (doc 03); equities are all 101
  address: string; // SPL mint / native sentinel
  eligibleRegions: "ALL" | "NON_RESTRICTED"; // doc 04 semantics
  disclosure?: string; // equity only — the "token ≠ share" line
  issuer?: "Backed"; // equity only
}

// Disclosure copy (PS-F8.3 pattern, "token ≠ share"). Data only — module 12
// renders it. The three fixed clauses are shared via one constant so they can
// never drift between entries. Stocks use "tracks {underlying} stock"; the ETF
// products (SPYx/QQQx) use "tracks the {index} ETF" — factually per index (QQQx
// tracks the Nasdaq-100, NOT the S&P 500; see HANDOFF deviation note).
const FIXED_CLAUSES =
  "It is not a share — no voting rights or dividend claims. Issuer: Backed.";
const stockDisclosure = (ticker: string, underlying: string) =>
  `${ticker} tracks ${underlying} stock. ${FIXED_CLAUSES}`;
const etfDisclosure = (ticker: string, index: string) =>
  `${ticker} tracks the ${index} ETF. ${FIXED_CLAUSES}`;

export const REGISTRY: readonly RegistryAsset[] = [
  // ── Tokenized equities — xStocks SPL mints, Solana (101), issuer Backed ──
  {
    id: "tslax",
    ticker: "TSLAx",
    name: "Tesla (tokenized)",
    kind: "equity",
    chainId: 101,
    address: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    eligibleRegions: "NON_RESTRICTED",
    disclosure: stockDisclosure("TSLAx", "Tesla"),
    issuer: "Backed",
  },
  {
    id: "aaplx",
    ticker: "AAPLx",
    name: "Apple (tokenized)",
    kind: "equity",
    chainId: 101,
    address: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    eligibleRegions: "NON_RESTRICTED",
    disclosure: stockDisclosure("AAPLx", "Apple"),
    issuer: "Backed",
  },
  {
    id: "nvdax",
    ticker: "NVDAx",
    name: "NVIDIA (tokenized)",
    kind: "equity",
    chainId: 101,
    address: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    eligibleRegions: "NON_RESTRICTED",
    disclosure: stockDisclosure("NVDAx", "NVIDIA"),
    issuer: "Backed",
  },
  {
    id: "spyx",
    ticker: "SPYx",
    name: "S&P 500 (tokenized)",
    kind: "equity",
    chainId: 101,
    address: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    eligibleRegions: "NON_RESTRICTED",
    disclosure: etfDisclosure("SPYx", "S&P 500"),
    issuer: "Backed",
  },
  {
    id: "qqqx",
    ticker: "QQQx",
    name: "Nasdaq-100 (tokenized)",
    kind: "equity",
    chainId: 101,
    address: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ",
    eligibleRegions: "NON_RESTRICTED",
    disclosure: etfDisclosure("QQQx", "Nasdaq-100"),
    issuer: "Backed",
  },

  // ── Native crypto — never region-restricted (ALL); the blocked-region basket ──
  // SOL's address is the 0x000…000 native sentinel AS THE SPEC PINS IT — passed
  // through to UA calls verbatim, not "fixed" to a Solana-style constant (doc 05).
  {
    id: "sol",
    ticker: "SOL",
    name: "Solana",
    kind: "crypto",
    chainId: 101,
    address: "0x0000000000000000000000000000000000000000",
    eligibleRegions: "ALL",
  },
  {
    id: "eth",
    ticker: "ETH",
    name: "Ethereum",
    kind: "crypto",
    chainId: 1,
    address: "0x0000000000000000000000000000000000000000",
    eligibleRegions: "ALL",
  },

  // ── TO PIN (msftx / amznx / googlx / metax / mstrx) ──
  // Appended ONLY after the doc-05 verification procedure (≥2 independent
  // sources + `Xs` prefix + real liquidity), each with an evidence comment.
  // Unverifiable tickers stay ABSENT — never guessed. The launch set does not
  // require all ten.
];

export const REGISTRY_IDS = REGISTRY.map((a) => a.id) as [string, ...string[]]; // doc 09 z.enum input
export const XS_PREFIX = "Xs";

// Fake-mint guard at MODULE LOAD (doc 05 DoD): importing the registry with a
// non-`Xs` equity, a wrong chain, a missing disclosure, or a duplicate id throws
// here — at build/test time, not as a runtime surprise during a live buy.
validateRegistry(REGISTRY);
