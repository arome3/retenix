// packages/ua/src/methods.ts — thin passthroughs over the UA instance (doc 03 task 10).
//
// Downstream modules call THESE, never the SDK. Retenix NEVER routes manually — the
// create-* methods hand routing to Particle (Raydium CLMM primary, Jupiter-aggregated).
// Routing table (tech spec §5):
//   F2 sweep (doc 06)     → getPrimaryAssets + batched createSellTransaction
//   F4 buys (doc 08)      → createBuyTransaction
//   F6 kill (doc 13)      → createSellTransaction / createConvertTransaction
//   F7 estate (doc 14)    → createTransferTransaction (fallback path only, CONFLICTS #14)
//   F9 send (doc 15)      → createTransferTransaction
//   history (doc 11)      → getTransactions / getTokenTransactions
import type {
  UniversalAccount,
  IAssetsResponse,
  IBasicToken,
  IBuyTransaction,
  ISellTransaction,
  IConvertTransaction,
  ITradeConfig,
  ITransferTransaction,
  ITransaction,
  ISmartAccountOptions,
} from "@particle-network/universal-account-sdk";

// --- Balances & assets (doc 06 buying power + per-chain breakdown) ---
export function getPrimaryAssets(ua: UniversalAccount): Promise<IAssetsResponse> {
  return ua.getPrimaryAssets();
}

export function getSmartAccountOptions(
  ua: UniversalAccount,
): Promise<ISmartAccountOptions> {
  return ua.getSmartAccountOptions();
}

// --- Transaction creation (create → sign → send in ONE flow; quotes expire) ---
export function createBuyTransaction(
  ua: UniversalAccount,
  payload: IBuyTransaction,
): Promise<ITransaction> {
  return ua.createBuyTransaction(payload);
}

/**
 * `tradeConfig` (added for doc 06): a sell's destination is router-chosen among
 * the enabled primary tokens unless constrained. The sweep passes
 * `{ usePrimaryTokens: [SUPPORTED_TOKEN_TYPE.USDC] }` because "sells route only
 * to USDC in the user's own UA" is a doc 06 hard constraint. Omitted, the SDK
 * default (all five primaries) applies — existing callers are unaffected.
 */
export function createSellTransaction(
  ua: UniversalAccount,
  payload: ISellTransaction,
  tradeConfig?: ITradeConfig,
): Promise<ITransaction> {
  return ua.createSellTransaction(payload, tradeConfig);
}

export function createConvertTransaction(
  ua: UniversalAccount,
  payload: IConvertTransaction,
): Promise<ITransaction> {
  return ua.createConvertTransaction(payload);
}

export function createTransferTransaction(
  ua: UniversalAccount,
  payload: ITransferTransaction,
): Promise<ITransaction> {
  return ua.createTransferTransaction(payload);
}

// --- History ---
export function getTransactions(
  ua: UniversalAccount,
  page?: number,
  limit?: number,
): Promise<unknown> {
  return ua.getTransactions(page, limit);
}

export function getTransaction(ua: UniversalAccount, id: string): Promise<unknown> {
  return ua.getTransaction(id);
}

export function getTokenTransactions(
  ua: UniversalAccount,
  token: IBasicToken,
  pageToken?: number,
): Promise<unknown> {
  return ua.getTokenTransactions(token, pageToken);
}

// --- Token warming (doc 05 warms the registry set at session start to cut latency) ---
export function warmUpToken(
  ua: UniversalAccount,
  token: IBasicToken,
): Promise<unknown> {
  return ua.warmUpToken(token);
}

// --- 7702 delegation status (doc 15 security page) ---
// OQ5: getEIP7702Deployments / getEIP7702Auth are typed `Promise<any>` in the 2.0.3
// d.ts. NOT yet introspected on mainnet (needs a funded smoke wallet — HANDOFF), so
// narrowed to `unknown` to force callers to validate rather than trust an `any`. The
// concrete shapes are frozen here once mainnet confirms them — never invented.
export function getEIP7702Deployments(ua: UniversalAccount): Promise<unknown> {
  return ua.getEIP7702Deployments();
}

/** `chainIds` is required — the SDK asserts each is supported before the RPC call. */
export function getEIP7702Auth(
  ua: UniversalAccount,
  chainIds: number[],
): Promise<unknown> {
  return ua.getEIP7702Auth(chainIds);
}
