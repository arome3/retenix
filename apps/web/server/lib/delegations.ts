// Live per-chain 7702 delegation status (doc 15 C13 §3) — the only screen
// besides receipts/breakdowns where network names appear (provenance).
//
// Two sources, composed honestly:
//   1. Particle's own index — getEIP7702Deployments() through the OQ5
//      provisional parser (@retenix/ua). Answers "delegated?" per chain.
//   2. Chain truth — eth_getCode(EOA) per chain, decoding the EIP-7702
//      designation 0xef0100‖delegate (module 14's keeper technique). Names
//      WHICH program the account points to: the Universal Account
//      implementation (from getEIP7702Auth), RetenixClaim (CLAIM_ADDRESSES),
//      or — honestly — an unknown delegate's address (TS-14.4's point).
//
// Failure law: anything unverifiable → { unavailable: true } → the page's
// "couldn't check just now". NEVER a fabricated checkmark; a stale ✓ is a
// fake ✓, so the cache is fresh-only (no serve-stale, unlike summaryCache).
import { JsonRpcProvider } from "ethers";
import {
  CLAIM_ADDRESSES,
  ESTATE_CHAIN_IDS,
  networkName,
  type DelegationRow,
  type DelegationsResult,
} from "@retenix/shared";
import {
  getEIP7702Auth,
  getEIP7702Deployments,
  parseEIP7702AuthTargets,
  parseEIP7702Deployments,
} from "@retenix/ua";
import { env } from "@/env";
import { serverUa } from "./ua";

export const DELEGATIONS_CACHE_TTL_MS = 30_000;

/** EIP-7702 designation prefix (0xef0100 ‖ 20-byte delegate). */
const DESIGNATION_PREFIX = "0xef0100";

export interface DelegationDeps {
  getDeployments(eoa: string): Promise<unknown>;
  getAuthTargets(eoa: string, chainIds: number[]): Promise<unknown>;
  /** eth_getCode on one chain; throws on RPC failure. */
  getCode(chainId: number, address: string): Promise<string>;
}

const RPC_URLS: Record<number, string> = {
  1: env.RPC_URL_ETHEREUM,
  56: env.RPC_URL_BSC,
  8453: env.RPC_URL_BASE,
  196: env.RPC_URL_XLAYER,
  42161: env.RPC_URL_ARBITRUM,
};

const providers = new Map<number, JsonRpcProvider>();
function provider(chainId: number): JsonRpcProvider {
  let p = providers.get(chainId);
  if (!p) {
    p = new JsonRpcProvider(RPC_URLS[chainId], undefined, { staticNetwork: true });
    providers.set(chainId, p);
  }
  return p;
}

export const defaultDelegationDeps = (): DelegationDeps => ({
  getDeployments: (eoa) => getEIP7702Deployments(serverUa(eoa)),
  getAuthTargets: (eoa, chainIds) => getEIP7702Auth(serverUa(eoa), chainIds),
  getCode: (chainId, address) => provider(chainId).getCode(address),
});

/** Decode the delegate address from EOA code, or null when not delegated /
 *  not a 7702 designation. */
export function decodeDelegate(code: string): string | null {
  const c = code.toLowerCase();
  if (!c.startsWith(DESIGNATION_PREFIX) || c.length !== 2 + 6 + 40) return null;
  return `0x${c.slice(8)}`;
} // copy-canon-allow

// copy-canon-allow — server identifiers, not user copy (×4 lines below)
function nameDelegate( // copy-canon-allow
  delegate: string, // copy-canon-allow
  chainId: number,
  uaImplementations: Set<string>, // copy-canon-allow
): DelegationRow["delegate"] { // copy-canon-allow
  const d = delegate.toLowerCase();
  const claim = (
    (CLAIM_ADDRESSES as Record<number, string>)[chainId] ?? ""
  ).toLowerCase();
  const claimDeployed = claim !== "" && claim !== `0x${"0".repeat(40)}`;
  if (claimDeployed && d === claim) {
    return { kind: "claim", address: delegate };
  }
  if (uaImplementations.has(d)) return { kind: "ua", address: delegate };
  return { kind: "unknown", address: delegate };
}

/**
 * Build the five rows. Precedence: chain truth (getCode) decides both
 * "delegated?" and the name when readable; Particle's index answers
 * "delegated?" (named as the UA — it indexes its own delegation) for chains
 * whose RPC read failed. A chain with NO working source poisons the whole
 * panel to `unavailable` — a partial list would lie by omission.
 */
export async function buildDelegations(
  eoa: string,
  deps: DelegationDeps = defaultDelegationDeps(),
): Promise<DelegationsResult> {
  const chainIds = [...ESTATE_CHAIN_IDS];

  const [deploymentsRaw, authRaw, codes] = await Promise.all([
    deps.getDeployments(eoa).catch(() => null),
    deps.getAuthTargets(eoa, chainIds).catch(() => null),
    Promise.all(
      chainIds.map((chainId) =>
        deps
          .getCode(chainId, eoa)
          .then((code) => ({ chainId, code }))
          .catch(() => null),
      ),
    ),
  ]);

  const deployments = deploymentsRaw === null ? null : parseEIP7702Deployments(deploymentsRaw);
  const authTargets = authRaw === null ? null : parseEIP7702AuthTargets(authRaw);
  const uaImplementations = new Set(
    (authTargets ?? []).map((t) => t.address.toLowerCase()),
  );
  const delegatedByIndex = new Map(
    (deployments ?? []).map((d) => [d.chainId, d.isDelegated]),
  );

  const rows: DelegationRow[] = [];
  for (let i = 0; i < chainIds.length; i++) {
    const chainId = chainIds[i];
    const codeRead = codes[i];

    if (codeRead !== null) {
      // Chain truth available.
      const delegate = decodeDelegate(codeRead.code);
      rows.push({
        chainId,
        network: networkName(chainId), // copy-canon-allow (delegation panel context)
        delegated: delegate !== null,
        ...(delegate !== null
          ? { delegate: nameDelegate(delegate, chainId, uaImplementations) }
          : {}),
      });
      continue;
    }
    if (deployments !== null) {
      // Particle's index only — it reports its OWN delegation, so a ✓ here
      // is named as the Universal Account (no address to show).
      const delegated = delegatedByIndex.get(chainId) ?? false;
      rows.push({
        chainId,
        network: networkName(chainId), // copy-canon-allow (delegation panel context)
        delegated,
        ...(delegated ? { delegate: { kind: "ua" as const } } : {}),
      });
      continue;
    }
    // No source could answer for this chain — the whole panel degrades.
    return { unavailable: true };
  }

  return { unavailable: false, rows, asOf: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Fresh-only per-user cache (module 06's summaryCache shape, WITHOUT the
// serve-stale half — see the header).
// ---------------------------------------------------------------------------

const cache = new Map<string, { at: number; result: DelegationsResult }>();

export const delegationsCache = {
  fresh(userId: string, now = Date.now()): DelegationsResult | null {
    const entry = cache.get(userId);
    if (!entry || now - entry.at >= DELEGATIONS_CACHE_TTL_MS) return null;
    return entry.result;
  },
  set(userId: string, result: DelegationsResult, now = Date.now()): void {
    if (result.unavailable) return; // never cache a failure
    cache.set(userId, { at: now, result });
  },
  clear(): void {
    cache.clear();
  },
};
