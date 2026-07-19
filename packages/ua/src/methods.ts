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

/**
 * `tradeConfig` (added for doc 13, the createSellTransaction precedent):
 * converts are OUTPUT-denominated (`expectToken`), so unconstrained the router
 * funds "expect N USDC" from ANY primary — including USDC itself (pointless
 * fee-paying churn) or a mix that collides with a sibling convert leg. The
 * kill switch passes `{ usePrimaryTokens: [<that primary>] }` per leg so each
 * convert drains exactly one primary. Omitted, the SDK default applies —
 * existing callers are unaffected.
 */
export function createConvertTransaction(
  ua: UniversalAccount,
  payload: IConvertTransaction,
  tradeConfig?: ITradeConfig,
): Promise<ITransaction> {
  return ua.createConvertTransaction(payload, tradeConfig);
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
// d.ts. The passthroughs stay `unknown` so callers must validate rather than trust
// an `any`; the PROVISIONAL interfaces + parsers below are the doc-15 freeze.
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

// --- OQ5 freeze (PROVISIONAL — doc 15) -------------------------------------
//
// Shape source: Particle's own demo (github.com/Particle-Network/ua-dynamic-7702,
// hooks/universal-account-provider.tsx) consumes getEIP7702Deployments() as an
// ARRAY of per-chain records — `deployments.find((d) => d.chainId === …)?.isDelegated`
// — and getEIP7702Auth() entries as `{ address, nonce }`. Not yet corroborated by a
// live mainnet capture (placeholder creds — HANDOFF owner-action:
// `pnpm --filter worker verify:send` logs the raw payload; reconcile here if it
// differs). Parsers return null on ANY mismatch so a wrong guess can only ever
// produce the security page's honest "couldn't check just now" state — never a
// fabricated checkmark (doc 15 Security & failure modes).

/** Per-chain 7702 delegation status as Particle's index reports it. */
export interface EIP7702Deployment {
  chainId: number;
  isDelegated: boolean;
}

/** One authorization target from getEIP7702Auth: the delegate contract Particle
 *  wants installed (the Universal Account implementation) + the signing nonce. */
export interface EIP7702AuthTarget {
  chainId?: number;
  address: string;
  nonce: number;
}

/** Validate a raw getEIP7702Deployments() payload. Null = shape mismatch. */
export function parseEIP7702Deployments(raw: unknown): EIP7702Deployment[] | null {
  if (!Array.isArray(raw)) return null;
  const out: EIP7702Deployment[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const rec = item as Record<string, unknown>;
    if (typeof rec.chainId !== "number" || typeof rec.isDelegated !== "boolean") {
      return null;
    }
    out.push({ chainId: rec.chainId, isDelegated: rec.isDelegated });
  }
  return out;
}

/** Validate a raw getEIP7702Auth() payload. Null = shape mismatch. */
export function parseEIP7702AuthTargets(raw: unknown): EIP7702AuthTarget[] | null {
  if (!Array.isArray(raw)) return null;
  const out: EIP7702AuthTarget[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const rec = item as Record<string, unknown>;
    if (typeof rec.address !== "string" || typeof rec.nonce !== "number") return null;
    out.push({
      ...(typeof rec.chainId === "number" ? { chainId: rec.chainId } : {}),
      address: rec.address,
      nonce: rec.nonce,
    });
  }
  return out;
}
