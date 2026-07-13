import {
  DUST_FLOOR_USD,
  type FeeTotals,
  type SweepSkipReason,
} from "@retenix/shared";
import { REGISTRY } from "@retenix/registry";
import { SUPPORTED_PRIMARY_TOKENS } from "@retenix/ua";
import { formatUnits } from "ethers";
import { env } from "@/env";

/*
 * Dust scanner (doc 06) — finds non-primary token balances across the six
 * networks and applies the honesty rules. Mechanics are PROPOSED (spec-silent;
 * the spec fixes the WHAT): EVM chains are read with Alchemy's token API on
 * the canonical RPC_URL_* endpoints, Solana with getTokenAccountsByOwner, and
 * USD valuation comes from Alchemy's Prices API (key parsed from an Alchemy
 * RPC URL). Every rule is a pure function; network access and sell-quoting are
 * injected so unit tests exercise the rules, not the internet.
 *
 * Exclusions (silent — these are not "couldn't sweep", they are "not dust"):
 *   • the five primary assets per chain (SUPPORTED_PRIMARY_TOKENS — the SDK's
 *     own per-chain address list; they are already buying power), and
 *   • every REGISTRY address (the portfolio, not dust — doc 05 composition).
 * Skips (reported, human-readable): source down/unsupported, no price (spam),
 * below the $0.25 floor, quoted fees ≥ value, quote failed.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface DustCandidate {
  chainId: number;
  /** ERC-20 contract address or SPL mint. */
  token: string;
  symbol: string;
  decimals: number;
  /** Base-unit balance as a decimal string. */
  amountRaw: string;
}

export interface DustItem {
  chainId: number;
  token: string;
  symbol: string;
  usd: number;
  /** Human-decimal amount — exactly what ISellTransaction.amount takes. */
  amountHuman: string;
  feesQuoted: FeeTotals;
}

export interface DustSkip {
  chainId: number;
  reason: SweepSkipReason;
  token?: string;
  symbol?: string;
  usd?: number;
}

export interface DustScanResult {
  totalUsd: number;
  items: DustItem[];
  skipped: DustSkip[];
  /** Aggregate quoted fees across items — the ConfirmSheet's "fees ~$X". */
  fees: FeeTotals;
}

export interface DustScanDeps {
  /** JSON-RPC POST; resolves the parsed `result`, throws RpcMethodUnsupported
   *  for method-not-found, any other Error for transport failures. */
  rpc(url: string, method: string, params: unknown[]): Promise<unknown>;
  /** USD prices for (priceNetwork, address) pairs; missing = unpriceable. */
  prices(
    pairs: { network: string; address: string }[],
  ): Promise<Map<string, number>>;
  /** Quote a sell of the full balance (routes wire createSellTransaction →
   *  parseFeeTotals with the USDC-only tradeConfig). */
  quoteSell(item: {
    chainId: number;
    token: string;
    amountHuman: string;
  }): Promise<FeeTotals>;
}

// ---------------------------------------------------------------------------
// The six sources (G3) — five EVM endpoints + Solana
// ---------------------------------------------------------------------------

type EvmSource = {
  chainId: number;
  url: string;
  /** Alchemy Prices API network slug; null = unpriceable there. */
  priceNetwork: string | null;
};

function evmSources(): EvmSource[] {
  return [
    { chainId: 1, url: env.RPC_URL_ETHEREUM, priceNetwork: "eth-mainnet" },
    { chainId: 8453, url: env.RPC_URL_BASE, priceNetwork: "base-mainnet" },
    { chainId: 42161, url: env.RPC_URL_ARBITRUM, priceNetwork: "arb-mainnet" },
    { chainId: 56, url: env.RPC_URL_BSC, priceNetwork: "bnb-mainnet" },
    { chainId: 196, url: env.RPC_URL_XLAYER, priceNetwork: null },
  ];
}

const SOLANA_CHAIN_ID = 101;
const SOLANA_PRICE_NETWORK = "solana-mainnet";
// Classic SPL Token + Token-2022 — dust lives under both programs.
const SOLANA_TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

/** Tokens per source cap — a bound against pathological airdrop wallets, high
 *  enough that hitting it is reported rather than silently truncated. */
const MAX_TOKENS_PER_SOURCE = 100;

// ---------------------------------------------------------------------------
// Pure rules (unit-fixtured)
// ---------------------------------------------------------------------------

const key = (chainId: number, token: string) =>
  `${chainId}:${token.toLowerCase()}`;

/** chainId:address(lower) for every primary asset and registry holding. */
export function buildExclusionSet(): Set<string> {
  const set = new Set<string>();
  for (const t of SUPPORTED_PRIMARY_TOKENS) set.add(key(t.chainId, t.address));
  for (const a of REGISTRY) set.add(key(a.chainId, a.address));
  return set;
}

/** Primary assets and registry holdings are not dust — silently excluded. */
export function isExcluded(
  candidate: Pick<DustCandidate, "chainId" | "token">,
  excluded: Set<string>,
): boolean {
  return excluded.has(key(candidate.chainId, candidate.token));
}

/** Value rules: unpriceable = spam ("no-price"), tiny = "below-floor". */
export function applyValueRules(
  candidate: DustCandidate,
  price: number | null | undefined,
): { kind: "keep"; usd: number } | { kind: "skip"; reason: SweepSkipReason } {
  if (price == null || !Number.isFinite(price) || price <= 0) {
    return { kind: "skip", reason: "no-price" };
  }
  const usd = price * Number(humanAmount(candidate));
  if (!Number.isFinite(usd) || usd < DUST_FLOOR_USD) {
    return { kind: "skip", reason: "below-floor" };
  }
  return { kind: "keep", usd };
}

/** Selling $0.30 to pay $0.40 in fees is anti-user (doc 06). */
export function feesExceedValue(usd: number, fees: FeeTotals): boolean {
  return fees.total >= usd;
}

/**
 * Base units → the human-decimal string ISellTransaction.amount expects.
 * The SDK parses it at 18-decimal fixed point, so deeper-precision tokens are
 * floor-truncated to 18 fractional digits (sells a hair less, never more).
 */
export function humanAmount(
  c: Pick<DustCandidate, "amountRaw" | "decimals">,
): string {
  const human = formatUnits(BigInt(c.amountRaw), c.decimals);
  const [whole, frac] = human.split(".");
  if (!frac || frac.length <= 18) return human;
  const cut = frac.slice(0, 18).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole;
}

export function aggregateFees(items: { feesQuoted: FeeTotals }[]): FeeTotals {
  return items.reduce(
    (sum, { feesQuoted: f }) => ({
      gas: sum.gas + f.gas,
      service: sum.service + f.service,
      lp: sum.lp + f.lp,
      total: sum.total + f.total,
    }),
    { gas: 0, service: 0, lp: 0, total: 0 },
  );
}

// ---------------------------------------------------------------------------
// Per-source balance readers
// ---------------------------------------------------------------------------

export class RpcMethodUnsupported extends Error {}

type TokenBalanceRow = { contractAddress: string; tokenBalance: string | null };

async function scanEvmSource(
  source: EvmSource,
  address: string,
  excluded: Set<string>,
  deps: DustScanDeps,
): Promise<DustCandidate[]> {
  const balances = (await deps.rpc(source.url, "alchemy_getTokenBalances", [
    address,
    "erc20",
  ])) as { tokenBalances?: TokenBalanceRow[] };

  const nonzero = (balances.tokenBalances ?? [])
    .filter((row) => {
      if (!row.tokenBalance) return false;
      try {
        return BigInt(row.tokenBalance) > 0n;
      } catch {
        return false;
      }
    })
    .filter((row) => !isExcluded({ chainId: source.chainId, token: row.contractAddress }, excluded))
    .slice(0, MAX_TOKENS_PER_SOURCE);

  const candidates: DustCandidate[] = [];
  for (const row of nonzero) {
    const meta = (await deps.rpc(source.url, "alchemy_getTokenMetadata", [
      row.contractAddress,
    ])) as { symbol?: string | null; decimals?: number | null } | null;
    // Metadata-less contracts are spam-shaped — they land in no-price anyway;
    // dropping here saves a priced round trip. Balance-only rows keep going.
    if (!meta || meta.decimals == null || !meta.symbol) continue;
    candidates.push({
      chainId: source.chainId,
      token: row.contractAddress,
      symbol: meta.symbol,
      decimals: meta.decimals,
      amountRaw: BigInt(row.tokenBalance as string).toString(),
    });
  }
  return candidates;
}

type SolanaTokenAccount = {
  account?: {
    data?: {
      parsed?: {
        info?: {
          mint?: string;
          tokenAmount?: { amount?: string; decimals?: number };
        };
      };
    };
  };
};

async function scanSolanaSource(
  owner: string,
  excluded: Set<string>,
  deps: DustScanDeps,
): Promise<DustCandidate[]> {
  const byMint = new Map<string, DustCandidate>();
  for (const programId of SOLANA_TOKEN_PROGRAMS) {
    const res = (await deps.rpc(env.RPC_URL_SOLANA, "getTokenAccountsByOwner", [
      owner,
      { programId },
      { encoding: "jsonParsed" },
    ])) as { value?: SolanaTokenAccount[] };

    for (const acct of res.value ?? []) {
      const info = acct.account?.data?.parsed?.info;
      const mint = info?.mint;
      const amount = info?.tokenAmount?.amount;
      const decimals = info?.tokenAmount?.decimals;
      if (!mint || !amount || decimals == null) continue;
      if (BigInt(amount) <= 0n) continue;
      if (isExcluded({ chainId: SOLANA_CHAIN_ID, token: mint }, excluded)) continue;
      const existing = byMint.get(mint);
      const merged = existing
        ? (BigInt(existing.amountRaw) + BigInt(amount)).toString()
        : amount;
      byMint.set(mint, {
        chainId: SOLANA_CHAIN_ID,
        token: mint,
        // jsonParsed carries no symbol; a truncated mint is honest and unique
        // enough for dust rows (SPL metadata lookups are out of v1 scope).
        symbol: existing?.symbol ?? `${mint.slice(0, 4)}…`,
        decimals,
        amountRaw: merged,
      });
    }
  }
  return [...byMint.values()].slice(0, MAX_TOKENS_PER_SOURCE);
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export interface DustScanUser {
  /** EVM scan target — the EOA ≡ the UA EVM address in 7702 mode. */
  eoaAddr: string;
  /** Solana scan target; "" until account.bootstrap has run → source skipped. */
  uaSolAddr: string;
}

export async function scanDust(
  user: DustScanUser,
  deps: DustScanDeps,
): Promise<DustScanResult> {
  const excluded = buildExclusionSet();
  const skipped: DustSkip[] = [];
  const candidates: DustCandidate[] = [];

  // Continue-and-report per source: one dead endpoint never kills the scan.
  const sourceJobs: { chainId: number; run: () => Promise<DustCandidate[]> }[] =
    evmSources().map((source) => ({
      chainId: source.chainId,
      run: () => scanEvmSource(source, user.eoaAddr, excluded, deps),
    }));
  if (user.uaSolAddr) {
    sourceJobs.push({
      chainId: SOLANA_CHAIN_ID,
      run: () => scanSolanaSource(user.uaSolAddr, excluded, deps),
    });
  } else {
    skipped.push({ chainId: SOLANA_CHAIN_ID, reason: "source-unavailable" });
  }

  const settled = await Promise.allSettled(sourceJobs.map((j) => j.run()));
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      candidates.push(...result.value);
    } else {
      skipped.push({
        chainId: sourceJobs[i].chainId,
        reason:
          result.reason instanceof RpcMethodUnsupported
            ? "source-unsupported"
            : "source-unavailable",
      });
    }
  });

  // Price the survivors in one batch, then apply the value rules.
  const priceNetworkByChain = new Map<number, string | null>(
    evmSources().map((s) => [s.chainId, s.priceNetwork] as const),
  );
  priceNetworkByChain.set(SOLANA_CHAIN_ID, SOLANA_PRICE_NETWORK);

  const pricePairs = candidates.flatMap((c) => {
    const network = priceNetworkByChain.get(c.chainId);
    return network ? [{ network, address: c.token }] : [];
  });
  let priceMap = new Map<string, number>();
  if (pricePairs.length > 0) {
    try {
      priceMap = await deps.prices(pricePairs);
    } catch {
      priceMap = new Map(); // pricing down → everything lands in no-price, honestly
    }
  }

  const valued: (DustCandidate & { usd: number })[] = [];
  for (const c of candidates) {
    const network = priceNetworkByChain.get(c.chainId);
    const price = network
      ? priceMap.get(`${network}:${c.token.toLowerCase()}`)
      : null;
    const verdict = applyValueRules(c, price ?? null);
    if (verdict.kind === "skip") {
      skipped.push({
        chainId: c.chainId,
        token: c.token,
        symbol: c.symbol,
        reason: verdict.reason,
      });
    } else {
      valued.push({ ...c, usd: verdict.usd });
    }
  }

  // Quote each survivor (bounded concurrency; a failed quote is a skip, not a crash).
  const items: DustItem[] = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < valued.length; i += CONCURRENCY) {
    const batch = valued.slice(i, i + CONCURRENCY);
    const quotes = await Promise.allSettled(
      batch.map((c) =>
        deps.quoteSell({
          chainId: c.chainId,
          token: c.token,
          amountHuman: humanAmount(c),
        }),
      ),
    );
    quotes.forEach((q, j) => {
      const c = batch[j];
      if (q.status === "rejected") {
        skipped.push({
          chainId: c.chainId,
          token: c.token,
          symbol: c.symbol,
          usd: c.usd,
          reason: "quote-failed",
        });
        return;
      }
      if (feesExceedValue(c.usd, q.value)) {
        skipped.push({
          chainId: c.chainId,
          token: c.token,
          symbol: c.symbol,
          usd: c.usd,
          reason: "fees-exceed-value",
        });
        return;
      }
      items.push({
        chainId: c.chainId,
        token: c.token,
        symbol: c.symbol,
        usd: c.usd,
        amountHuman: humanAmount(c),
        feesQuoted: q.value,
      });
    });
  }

  items.sort((a, b) => b.usd - a.usd);
  return {
    totalUsd: items.reduce((sum, item) => sum + item.usd, 0),
    items,
    skipped,
    fees: aggregateFees(items),
  };
}

// ---------------------------------------------------------------------------
// Default network deps (the routes use these; tests inject fakes)
// ---------------------------------------------------------------------------

/** Alchemy API key, parsed from the first Alchemy-shaped RPC URL. */
export function alchemyKeyFromEnv(): string | null {
  for (const url of [
    env.RPC_URL_ETHEREUM,
    env.RPC_URL_BASE,
    env.RPC_URL_ARBITRUM,
    env.RPC_URL_BSC,
    env.RPC_URL_SOLANA,
  ]) {
    const match = /\.g\.alchemy\.com\/v2\/([A-Za-z0-9_-]+)/.exec(url);
    if (match) return match[1];
  }
  return null;
}

async function jsonRpc(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} → HTTP ${res.status}`);
  const body = (await res.json()) as {
    result?: unknown;
    error?: { code?: number; message?: string };
  };
  if (body.error) {
    // -32601 = method not found — a permanent capability gap, not an outage.
    if (body.error.code === -32601) {
      throw new RpcMethodUnsupported(body.error.message ?? method);
    }
    throw new Error(body.error.message ?? `rpc ${method} failed`);
  }
  return body.result;
}

const PRICE_BATCH_MAX = 25;

async function alchemyPrices(
  pairs: { network: string; address: string }[],
): Promise<Map<string, number>> {
  const apiKey = alchemyKeyFromEnv();
  const map = new Map<string, number>();
  if (!apiKey || pairs.length === 0) return map;

  for (let i = 0; i < pairs.length; i += PRICE_BATCH_MAX) {
    const batch = pairs.slice(i, i + PRICE_BATCH_MAX);
    const res = await fetch(
      `https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/by-address`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addresses: batch }),
      },
    );
    if (!res.ok) throw new Error(`prices → HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: {
        network?: string;
        address?: string;
        prices?: { currency?: string; value?: string }[];
      }[];
    };
    for (const row of body.data ?? []) {
      const usd = row.prices?.find((p) => p.currency?.toLowerCase() === "usd");
      const value = usd?.value ? Number(usd.value) : NaN;
      if (row.network && row.address && Number.isFinite(value)) {
        map.set(`${row.network}:${row.address.toLowerCase()}`, value);
      }
    }
  }
  return map;
}

/** Production deps — network readers here, sell-quoting supplied per call by
 *  the route (it owns the UA instance and the USDC-only tradeConfig). */
export function defaultDustDeps(
  quoteSell: DustScanDeps["quoteSell"],
): DustScanDeps {
  return { rpc: jsonRpc, prices: alchemyPrices, quoteSell };
}
