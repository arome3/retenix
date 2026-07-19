// Send/withdraw server core (doc 15) — recipient resolution, USD→token-unit
// math, and the on-chain delivery proof behind the recipient's receipt.
// Everything here is pure or deps-injected (the dust.ts discipline) so the
// resolution ladder and the money math are unit-testable without a network.
import { getAddress, parseUnits, zeroPadValue } from "ethers";
import { users, type Db } from "@retenix/db";
import { maskEmail } from "@retenix/shared";
import {
  CHAIN_ID,
  RETENIX_PRIMARY_ASSETS,
  SUPPORTED_TOKEN_TYPE,
  networksForAsset,
  primaryTokenFor,
} from "@retenix/ua";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { hashEmail } from "@/lib/emailHash";
import { truncAddr } from "@/lib/format";
import { resolveEnsName } from "./ens";

// ---------------------------------------------------------------------------
// Recipient resolution (the doc-15 ladder: email → ENS → address). The SAME
// function runs at preview (send.resolve) and inside authorize — the server
// re-validates at execute time by construction.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type SendResolution =
  | { kind: "registered"; recipientUserId: string; address: string; display: string }
  | { kind: "unregistered"; email: string; display: string }
  | { kind: "external"; address: string; display: string };

export interface ResolveDeps {
  resolveEns(name: string): Promise<string | null>;
}

export const defaultResolveDeps = (): ResolveDeps => ({
  resolveEns: (name) => resolveEnsName(name),
});

const bad = (message: string): never => {
  throw new TRPCError({ code: "BAD_REQUEST", message });
};

/**
 * Resolve a recipient or throw BAD_REQUEST with the honest form copy. A send
 * to an unresolved/ambiguous recipient must never proceed (doc 15 Never list).
 * `solanaTarget` switches address validation to base58 (withdraws to chain 101).
 */
export async function resolveRecipient(
  db: Db,
  to: { kind: "email" | "ens" | "address"; value: string },
  deps: ResolveDeps = defaultResolveDeps(),
  opts: { solanaTarget?: boolean } = {},
): Promise<SendResolution> {
  const value = to.value.trim();
  switch (to.kind) {
    case "email": {
      if (!EMAIL_RE.test(value)) return bad("that doesn't look like an email");
      const email = value.toLowerCase(); // emails are case-insensitive here (hashEmail folds too)
      const [row] = await db
        .select({ id: users.id, eoaAddr: users.eoaAddr })
        .from(users)
        .where(eq(users.emailHash, hashEmail(email)))
        .limit(1);
      const display = maskEmail(email);
      if (!row) return { kind: "unregistered", email, display };
      // 7702: the recipient's UA EVM address ≡ their EOA (module 03 pins the
      // equality at bootstrap); eoa_addr is always set, ua_evm_addr may still
      // be "" pre-bootstrap — eoa_addr is the receiver either way.
      return {
        kind: "registered",
        recipientUserId: row.id,
        address: row.eoaAddr,
        display,
      };
    }
    case "ens": {
      const address = await deps.resolveEns(value);
      if (!address) return bad("name not found");
      return { kind: "external", address, display: value.toLowerCase() };
    }
    case "address": {
      if (opts.solanaTarget) {
        if (!BASE58_RE.test(value)) return bad("that address doesn't look right");
        return { kind: "external", address: value, display: truncAddr(value) };
      }
      let address: string;
      try {
        address = getAddress(value); // checksum-validate + canonical casing
      } catch {
        return bad("that address doesn't look right");
      }
      return { kind: "external", address, display: truncAddr(address) };
    }
  }
}

// ---------------------------------------------------------------------------
// Withdraw pair validation + USD→token units
// ---------------------------------------------------------------------------

export interface WithdrawToken {
  chainId: number;
  address: string;
  /** ON-CHAIN precision (IToken.realDecimals — never the 18-dp normalized). */
  decimals: number;
  symbol: string;
  tokenType: string;
}

/** Validate the user's explicit (asset, network) choice against the SDK's own
 *  availability — the same derivation the withdraw UI lists. */
export function withdrawToken(asset: string, chainId: number): WithdrawToken {
  const known = (RETENIX_PRIMARY_ASSETS as readonly string[]).includes(asset);
  if (!known) return bad("unknown asset");
  const tokenType = asset as SUPPORTED_TOKEN_TYPE;
  if (!networksForAsset(tokenType).includes(chainId)) {
    return bad("that asset can't arrive there");
  }
  const token = primaryTokenFor(tokenType, chainId);
  if (!token) return bad("that asset can't arrive there");
  return {
    chainId,
    address: token.address,
    decimals: token.realDecimals,
    symbol: asset.toUpperCase(),
    tokenType: asset,
  };
}

/** Stablecoins move 1:1 with the USD amount (v1 posture, flagged in HANDOFF). */
const STABLE_TYPES = new Set<string>([
  SUPPORTED_TOKEN_TYPE.USDC,
  SUPPORTED_TOKEN_TYPE.USDT,
]);

export const isStable = (tokenType: string): boolean => STABLE_TYPES.has(tokenType);

/**
 * USD → exact token units, floor-truncated to the token's ON-CHAIN decimals
 * (never over-send — the dust.ts truncation posture). Returns a human decimal
 * string, the shape ITransferTransaction.amount expects.
 */
export function computeUnits(
  amountUsd: number,
  priceUsd: number,
  decimals: number,
): string {
  if (!(amountUsd > 0) || !(priceUsd > 0) || !Number.isFinite(amountUsd / priceUsd)) {
    return bad("couldn't price that amount");
  }
  const raw = amountUsd / priceUsd;
  // Truncate via base units to avoid float dust at high precision.
  const fixed = raw.toFixed(Math.min(decimals + 2, 20));
  const [whole, frac = ""] = fixed.split(".");
  const truncated = `${whole}${frac ? "." + frac.slice(0, decimals) : ""}`;
  // Normalize trailing zeros / dot ("2.500000" → "2.5", "2." → "2").
  return truncated.includes(".")
    ? truncated.replace(/\.?0+$/, "") || "0"
    : truncated;
}

/** Price + spendable USD for one primary asset, read from the user's own
 *  getPrimaryAssets feed (the kill-switch denomination source). */
export function primaryPriceAndBalance(
  primariesResp: unknown,
  tokenType: string,
): { price: number | null; amountInUSD: number } {
  const assets = ((primariesResp as { assets?: unknown[] })?.assets ?? []) as {
    tokenType?: unknown;
    price?: unknown;
    amountInUSD?: unknown;
  }[];
  const asset = assets.find((a) => a.tokenType === tokenType);
  if (!asset) return { price: null, amountInUSD: 0 };
  return {
    price:
      typeof asset.price === "number" && asset.price > 0 ? asset.price : null,
    amountInUSD:
      typeof asset.amountInUSD === "number" && Number.isFinite(asset.amountInUSD)
        ? asset.amountInUSD
        : 0,
  };
}

// ---------------------------------------------------------------------------
// Delivery proof (registered-email sends only) — chain truth, no OQ5
// dependency: the recipient's receipt is written ONLY when the settle chain
// shows a Transfer of ≥ the pinned units into the recipient's address after
// the authorize block. Cross-chain UA delivery may come from a solver, so the
// `from` topic is deliberately unconstrained.
// ---------------------------------------------------------------------------

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Sends settle on Arbitrum USDC (doc 15 PROPOSED default — "routing
 *  dissolves"; the recipient's UA aggregates wherever it lands). */
export const SEND_SETTLE_CHAIN_ID: number = CHAIN_ID.ARBITRUM_MAINNET_ONE;

export interface DeliveryDeps {
  getLogs(filter: {
    address: string;
    topics: (string | null)[];
    fromBlock: number;
    toBlock: "latest";
  }): Promise<{ data: string }[]>;
}

/** Delivered ≥98% of the pinned units (fee-side dust tolerance)? true /
 *  false / null = the check itself failed (RPC error — never a false claim
 *  either way; the caller withholds the recipient row on !== true). */
export async function verifyDelivery(
  deps: DeliveryDeps,
  args: {
    tokenAddress: string;
    tokenDecimals: number;
    recipient: string;
    amountUnits: string;
    fromBlock: number;
  },
): Promise<boolean | null> {
  let min: bigint;
  try {
    min = (parseUnits(args.amountUnits, args.tokenDecimals) * 98n) / 100n;
  } catch {
    return null;
  }
  try {
    const logs = await deps.getLogs({
      address: args.tokenAddress,
      topics: [TRANSFER_TOPIC, null, zeroPadValue(getAddress(args.recipient), 32)],
      fromBlock: args.fromBlock,
      toBlock: "latest",
    });
    for (const log of logs) {
      try {
        if (BigInt(log.data) >= min) return true;
      } catch {
        // malformed log data — keep scanning
      }
    }
    return false;
  } catch {
    return null;
  }
}
