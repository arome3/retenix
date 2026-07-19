// Estate asset enumeration (doc 14) — what the keeper emails ("$4,812 · 14
// assets · 5 sources") and what claim(owner, tokens[]) sweeps per chain.
// Modeled on the web dust scanner's injected-I/O discipline
// (apps/web/server/lib/dust.ts): rules are pure, network calls come in
// through EstateScanDeps so tests run hermetic.
//
// Coverage honesty: X Layer's public RPC lacks the Alchemy token API — its
// ERC-20s are unenumerable today (native balance still counts). The scan
// reports that as a skip, never silently.
import { formatUnits } from "ethers";
import { NETWORK_NAMES, type EstateAsset, type EstateSummary } from "@retenix/shared";

import { env } from "../env";

export interface EstateScanDeps {
  /** JSON-RPC POST returning the parsed `result` (throws on failure). */
  rpc(url: string, method: string, params: unknown[]): Promise<unknown>;
  /** USD prices for (network-slug, address) pairs; missing = unpriced. */
  prices(pairs: { network: string; address: string }[]): Promise<Map<string, number>>;
}

type EvmSource = { chainId: number; url: string; priceNetwork: string | null };

export function estateSources(): EvmSource[] {
  return [
    { chainId: 1, url: env.RPC_URL_ETHEREUM, priceNetwork: "eth-mainnet" },
    { chainId: 56, url: env.RPC_URL_BSC, priceNetwork: "bnb-mainnet" },
    { chainId: 8453, url: env.RPC_URL_BASE, priceNetwork: "base-mainnet" },
    { chainId: 196, url: env.RPC_URL_XLAYER, priceNetwork: null },
    { chainId: 42161, url: env.RPC_URL_ARBITRUM, priceNetwork: "arb-mainnet" },
  ];
}

/** Native-asset price slugs (wrapped-native contract per chain — the Prices
 *  API prices by token address; the wrapped twin is the standard proxy). */
const NATIVE_PRICE_PROXY: Record<number, { network: string; address: string } | null> = {
  1: { network: "eth-mainnet", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" }, // WETH
  56: { network: "bnb-mainnet", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" }, // WBNB
  8453: { network: "base-mainnet", address: "0x4200000000000000000000000000000000000006" },
  196: null, // OKB — unpriceable without an X Layer indexer (skip reports it)
  42161: { network: "arb-mainnet", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" },
};

export interface ChainScan {
  chainId: number;
  network: string;
  usd: number;
  /** ERC-20 contract addresses with nonzero balances — claim()'s tokens[]. */
  tokens: string[];
  assets: EstateAsset[];
  skips: string[];
}

interface TokenBalance {
  contractAddress: string;
  tokenBalance: string;
}

export async function scanChain(deps: EstateScanDeps, source: EvmSource, owner: string): Promise<ChainScan> {
  const network = NETWORK_NAMES[source.chainId] ?? `Source ${source.chainId}`;
  const assets: EstateAsset[] = [];
  const tokens: string[] = [];
  const skips: string[] = [];
  const pricePairs: { network: string; address: string }[] = [];
  const priced: { asset: EstateAsset; key: string; amount: number }[] = [];

  // native balance (always enumerable)
  let nativeAmount = 0;
  try {
    const hex = (await deps.rpc(source.url, "eth_getBalance", [owner, "latest"])) as string;
    nativeAmount = Number(formatUnits(BigInt(hex), 18));
  } catch {
    skips.push("native balance unavailable");
  }
  if (nativeAmount > 0) {
    const proxy = NATIVE_PRICE_PROXY[source.chainId];
    const asset: EstateAsset = {
      token: "native",
      symbol: source.chainId === 56 ? "BNB" : source.chainId === 196 ? "OKB" : "ETH",
      amountHuman: nativeAmount.toString(),
    };
    assets.push(asset);
    if (proxy) {
      pricePairs.push(proxy);
      priced.push({ asset, key: `${proxy.network}:${proxy.address.toLowerCase()}`, amount: nativeAmount });
    }
  }

  // ERC-20 enumeration (Alchemy token API; X Layer lacks it)
  try {
    const res = (await deps.rpc(source.url, "alchemy_getTokenBalances", [owner, "erc20"])) as {
      tokenBalances?: TokenBalance[];
    };
    for (const bal of res.tokenBalances ?? []) {
      if (!bal.tokenBalance || BigInt(bal.tokenBalance) === 0n) continue;
      let symbol = bal.contractAddress.slice(0, 8);
      let decimals = 18;
      try {
        const meta = (await deps.rpc(source.url, "alchemy_getTokenMetadata", [
          bal.contractAddress,
        ])) as { symbol?: string | null; decimals?: number | null };
        if (meta.symbol) symbol = meta.symbol;
        if (typeof meta.decimals === "number") decimals = meta.decimals;
      } catch {
        // metadata is display-only; the claim moves full balances regardless
      }
      const amount = Number(formatUnits(BigInt(bal.tokenBalance), decimals));
      const asset: EstateAsset = {
        token: bal.contractAddress,
        symbol,
        amountHuman: amount.toString(),
      };
      assets.push(asset);
      tokens.push(bal.contractAddress);
      if (source.priceNetwork) {
        pricePairs.push({ network: source.priceNetwork, address: bal.contractAddress });
        priced.push({
          asset,
          key: `${source.priceNetwork}:${bal.contractAddress.toLowerCase()}`,
          amount,
        });
      }
    }
  } catch {
    skips.push("token enumeration unavailable on this network");
  }

  // best-effort valuation — an unpriced asset still transfers, it just
  // doesn't count toward the summary number
  let usd = 0;
  if (pricePairs.length > 0) {
    try {
      const priceMap = await deps.prices(pricePairs);
      for (const p of priced) {
        const price = priceMap.get(p.key);
        if (price !== undefined) {
          p.asset.usd = p.amount * price;
          usd += p.asset.usd;
        }
      }
    } catch {
      skips.push("valuation unavailable");
    }
  }

  return { chainId: source.chainId, network, usd, tokens, assets, skips };
}

/** Full 5-chain scan → the S6/email summary + per-chain claim token lists. */
export async function scanEstate(
  deps: EstateScanDeps,
  owner: string,
): Promise<{ summary: EstateSummary; perChain: ChainScan[] }> {
  const perChain = await Promise.all(estateSources().map((s) => scanChain(deps, s, owner)));
  const summary: EstateSummary = {
    totalUsd: perChain.reduce((a, c) => a + c.usd, 0),
    assetCount: perChain.reduce((a, c) => a + c.assets.length, 0),
    // "5 sources" is the coverage copy (G3/G12); the summary reports where
    // assets actually are
    sourceCount: perChain.filter((c) => c.assets.length > 0).length,
    perChain: perChain.map((c) => ({
      chainId: c.chainId,
      network: c.network,
      usd: c.usd,
      assets: c.assets,
    })),
  };
  return { summary, perChain };
}

// ---------------------------------------------------------------------------
// Default I/O (the dust.ts implementations, worker-side)
// ---------------------------------------------------------------------------
export function defaultScanDeps(): EstateScanDeps {
  return {
    async rpc(url, method, params) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`rpc ${method} ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message ?? `rpc ${method} failed`);
      return body.result;
    },
    async prices(pairs) {
      // Alchemy Prices API — key parsed from an Alchemy RPC URL (the dust.ts
      // convention); absent → no valuation, assets still enumerate
      const match = /alchemy\.com\/v2\/([^/]+)/.exec(env.RPC_URL_ETHEREUM);
      const key = match?.[1];
      const out = new Map<string, number>();
      if (!key || key === "PLACEHOLDER" || key === "test") return out;
      for (let i = 0; i < pairs.length; i += 25) {
        const batch = pairs.slice(i, i + 25);
        const res = await fetch(
          `https://api.g.alchemy.com/prices/v1/${key}/tokens/by-address`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              addresses: batch.map((p) => ({ network: p.network, address: p.address })),
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!res.ok) continue;
        const body = (await res.json()) as {
          data?: { network?: string; address?: string; prices?: { currency?: string; value?: string }[] }[];
        };
        for (const row of body.data ?? []) {
          const usd = row.prices?.find((p) => p.currency === "usd")?.value;
          if (row.network && row.address && usd) {
            out.set(`${row.network}:${row.address.toLowerCase()}`, Number(usd));
          }
        }
      }
      return out;
    },
  };
}
