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

export type AssetKind = "equity" | "crypto" | "rwa-gold";
export interface RegistryAsset {
  id: string; // REGISTRY_IDS member; lowercase ticker
  ticker: string; // display: "SPYx"
  name: string; // "S&P 500 (tokenized)"
  kind: AssetKind;
  chainId: number; // CHAIN_ID values (doc 03); equities are all 101
  address: string; // SPL mint / native sentinel / ERC-20 contract
  eligibleRegions: "ALL" | "NON_RESTRICTED" | "NON_SANCTIONED"; // doc 04/20 semantics
  disclosure?: string; // equity + rwa-gold — the "token ≠ the underlying" line
  issuer?: "Backed" | "Paxos" | "Tether"; // equity (Backed) + rwa-gold (Paxos/Tether)
  // Informational only in v1: buys pass {chainId,address} to UA (which resolves
  // real decimals via IToken.decimals — HANDOFF §15), and sell-all uses qtyHuman.
  // Pinned for gold so the golden test can assert it (PAXG 18).
  decimals?: number;
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
// Tokenized gold (doc 20, PS-F13-AC3) — the "token claim ≠ vault access" line.
// VERBATIM (G12): "gold" is the sanctioned word; the string never says "RWA".
const GOLD_DISCLOSURE =
  "PAXG tracks physical gold held by Paxos. It is a token claim, not vault access. Issuer: Paxos.";

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

  // ── Tokenized gold — RWA tier (doc 20, F13). A plain DEX-liquid ERC-20 on
  //    Ethereum reached by the UNCHANGED createBuyTransaction pipeline. ──
  //
  // ⚠️  NO `Xs`-PREFIX TRIPWIRE EXISTS FOR ERC-20s (unlike xStocks mints): this
  //     pinned address + issuer-page verification + the golden test are the
  //     ENTIRE defense (G-R2). A registry PR changing it is security-review-
  //     required and MUST re-run the verify-then-pin procedure + a G-R1 buy.
  //
  // PAXG · Pax Gold. VERIFIED 2026-07-17 against ≥2 independent issuer sources:
  //   src1 (issuer, primary): Paxos-owned repo README —
  //     github.com/paxosglobal/paxos-gold-contract ("Interaction with PAXG is
  //     done at the address of the proxy at 0x45804880De22913dAFE09f4980848ECE6EcbAf78").
  //   src2 (issuer-verified explorer): etherscan.io/token/0x45804880de22913dafe09f4980848ece6ecbaf78
  //     — name "Paxos Gold", symbol PAXG, decimals 18, source-verified exact-match.
  // G-R3 fee note: PAXG's contract HAS an on-chain fee mechanism (feeRate/feeParts),
  //   historically ~0.02%, but Paxos set it to ZERO ("zero on-chain transfer fees",
  //   2024) — so received≈quoted today. Paxos CAN re-enable it, so G-R1 still asserts
  //   received-vs-quoted within tolerance rather than assuming parity.
  // XAUT (Tether Gold) is DEFERRED — it enters only after a passing G-R1 (doc 20;
  //   "PAXG alone suffices"). Its ready-to-pin address is in HANDOFF §20. The
  //   DEPRECATED old XAUT (0x4922a015…) must NEVER be pinned — golden-test-guarded.
  {
    id: "paxg",
    ticker: "PAXG",
    name: "Gold (tokenized)",
    kind: "rwa-gold",
    chainId: 1,
    address: "0x45804880De22913dAFE09f4980848ECE6EcbAf78",
    eligibleRegions: "NON_SANCTIONED",
    disclosure: GOLD_DISCLOSURE,
    issuer: "Paxos",
    decimals: 18,
  },

  // ── Verified TO PIN — appended after the doc-05 procedure (verified 2026-07-12):
  //    ≥2 independent sources, `Xs` prefix, real Raydium/Jupiter liquidity, issuer
  //    Backed. Source 1 for all five is the k.co.cr xStocks table, PROVEN reliable
  //    because its TSLAx/AAPLx/NVDAx/SPYx/QQQx match tech-spec §3 byte-for-byte.
  //    A registry PR changing any address below MUST re-run this procedure. ──

  // MSFTx · Microsoft. src2: Solflare stock page URL embedding the mint —
  // solflare.com/stocks/microsoft-xstock/XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX/
  {
    id: "msftx",
    ticker: "MSFTx",
    name: "Microsoft (tokenized)",
    kind: "equity",
    chainId: 101,
    address: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",
    eligibleRegions: "NON_RESTRICTED",
    disclosure: stockDisclosure("MSFTx", "Microsoft"),
    issuer: "Backed",
  },
  // AMZNx · Amazon. src2: Bitget web3 swap URL —
  // web3.bitget.com/en/swap/sol/Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg ;
  // src3: CoinGecko (issuer Backed Finance, active Raydium CLMM liquidity).
  {
    id: "amznx",
    ticker: "AMZNx",
    name: "Amazon (tokenized)",
    kind: "equity",
    chainId: 101,
    address: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg",
    eligibleRegions: "NON_RESTRICTED",
    disclosure: stockDisclosure("AMZNx", "Amazon"),
    issuer: "Backed",
  },
  // GOOGLx · Alphabet. src2: Solflare price page URL ("verified on Solana's token
  // registry") — solflare.com/prices/alphabet-xstock/XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN/
  {
    id: "googlx",
    ticker: "GOOGLx",
    name: "Alphabet (tokenized)",
    kind: "equity",
    chainId: 101,
    address: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
    eligibleRegions: "NON_RESTRICTED",
    disclosure: stockDisclosure("GOOGLx", "Alphabet"),
    issuer: "Backed",
  },
  // METAx · Meta. src2: Solflare stock + price page URLs —
  // solflare.com/stocks/meta-xstock/Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu/
  {
    id: "metax",
    ticker: "METAx",
    name: "Meta (tokenized)",
    kind: "equity",
    chainId: 101,
    address: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
    eligibleRegions: "NON_RESTRICTED",
    disclosure: stockDisclosure("METAx", "Meta"),
    issuer: "Backed",
  },
  // MSTRx · MicroStrategy (Strategy). src2: Solflare stock + price page URLs;
  // src3: Solana Compass — solanacompass.com/tokens/XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ
  {
    id: "mstrx",
    ticker: "MSTRx",
    name: "MicroStrategy (tokenized)",
    kind: "equity",
    chainId: 101,
    address: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
    eligibleRegions: "NON_RESTRICTED",
    disclosure: stockDisclosure("MSTRx", "MicroStrategy"),
    issuer: "Backed",
  },
];

export const REGISTRY_IDS = REGISTRY.map((a) => a.id) as [string, ...string[]]; // doc 09 z.enum input
export const XS_PREFIX = "Xs";

// Fake-mint guard at MODULE LOAD (doc 05 DoD): importing the registry with a
// non-`Xs` equity, a wrong chain, a missing disclosure, or a duplicate id throws
// here — at build/test time, not as a runtime surprise during a live buy.
validateRegistry(REGISTRY);
