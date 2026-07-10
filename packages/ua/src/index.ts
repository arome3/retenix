// @retenix/ua — the single integration layer for Particle Universal Accounts v2.0.3.
//
// The web app and the worker consume THIS package exclusively; no other code in the
// repo imports or touches @particle-network/universal-account-sdk (module 03 hard
// constraint, enforced by scripts/check-pins.mjs). Every feature (F2 sweep, F4 buys,
// F6 kill switch, F7 estate fallback, F9 send, history) is a thin orchestration over
// these primitives. This package holds NO keys — signers are injected.

// --- Core: construct a UA, read its addresses ---
export {
  createUa,
  getAddresses,
  type ParticleCreds,
  type UaAddresses,
} from "./ua";

// --- Signing: the two 7702 flows behind one interface ---
export {
  type UaSigner,
  magicSigner,
  walletSigner,
  type MagicSignerClient,
  type WalletSignerClient,
} from "./signers";

// --- Execute: the one signing loop, plus its testable auth-collection half ---
export {
  signAndSend,
  collectAuthorizations,
  type TransactionSender,
} from "./send";

// --- Fee preview (the ONLY fee parser) ---
export { parseFeeTotals, type FeeTotalsUSD } from "./fees";

// --- Transaction lifecycle ---
export {
  pollToTerminal,
  TERMINAL,
  type PollOutcome,
  type PollResult,
  type UaTransaction,
  type TransactionSource,
} from "./lifecycle";

// --- Thin passthroughs (balances, create-*, history, warming, 7702 status) ---
export * from "./methods";

// --- Canonical chain/asset constants (re-exported from the SDK) ---
export * from "./constants";

/** Receipt link for a UA transaction (PS-F4-AC2; every receipt renders it). */
export const activityUrl = (id: string): string =>
  `https://universalx.app/activity/details?id=${id}`;

// --- SDK transaction/asset/config TYPES, re-exported so downstream can type UA
//     instances and payloads WITHOUT importing the SDK directly. ---
export type {
  UniversalAccount,
  ITransaction,
  IUserOpWithChain,
  IUserOpEVM,
  IUserOpSolana,
  EIP7702Authorization,
  IAsset,
  IAssetsResponse,
  IChainAggregation,
  IBasicToken,
  IBuyTransaction,
  ISellTransaction,
  IConvertTransaction,
  ITransferTransaction,
  IExpectToken,
  ISmartAccountOptions,
  IFeeQuote,
  IFees,
  IFeeTotals,
  IToken,
  ITokenWithUSD,
  ITradeConfig,
} from "@particle-network/universal-account-sdk";
