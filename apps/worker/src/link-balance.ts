// Chainlink upkeep LINK-balance monitor (doc 17 §Observability trigger 5;
// doc 14: "upkeep LINK exhausted → ops alert (doc 16 runbook pre-checks; doc 17
// monitors)").
//
// WHY THIS IS THE LOUDEST ALERT WE HAVE. The inactivity deadline is the one
// mechanism that must fire even if every Retenix server is dark — it is the
// whole trust argument for the estate feature. Chainlink fires it, Chainlink is
// paid in LINK, and an upkeep that runs out of LINK simply stops. There is no
// error, no retry, no receipt: the countdown just never completes. Nothing else
// in the system notices.
//
// THRESHOLD, honestly. Doc 14 requires the alert and fixes no number, because
// OQ6 (the Arbitrum premium, parsed at ~50%) is unconfirmed until registration.
// contracts/script/RegisterUpkeep.md specifies a >= 5 LINK starting deposit on
// Arbitrum One, so the default warn level of 2 is 40% of that — enough runway to
// notice and top up. PROPOSED; resize once OQ6 is answered.
//
// WHAT IT READS, honestly. The upkeep is not registered yet (docs/deployments.md
// records "_unregistered_"), so there is no upkeep id to query and the correct
// read — `registry.getUpkeep(id).balance` — cannot be written against anything
// real. This reads the LINK token balance of the configured upkeep admin
// instead, which is the account that funds it. Once the upkeep exists, swap
// `readBalance` for the registry call and keep everything else.
//
// Unconfigured is not an alert. Paging about an upkeep nobody has registered
// would be noise, and noise is how a real page gets ignored.

import { Contract, JsonRpcProvider, formatUnits } from "ethers";

import { env } from "../env";
import { captureError, keeperLinkLow } from "./notify";

// LINK is a standard 18-decimal ERC-20; balanceOf is all we need.
const ERC20_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
] as const;

/** Re-warn at most hourly: a low balance stays low, and repeating every keeper
 *  tick (2 min prod / 15 s demo) would bury the channel it is trying to warn. */
const REWARN_MS = 60 * 60 * 1000;

let lastWarnedAt = 0;
let announcedUnconfigured = false;
let lazyProvider: JsonRpcProvider | null = null;

/**
 * Own provider rather than borrowing the keeper's: PolicyEstateClient keeps
 * its provider private, and widening a module-14 class's visibility to satisfy
 * an ops check is the wrong trade. Built once, only if the check is actually
 * configured, so an unconfigured deployment opens no socket at all.
 */
function providerFor(): JsonRpcProvider {
  lazyProvider ??= new JsonRpcProvider(env.RPC_URL_ARBITRUM, undefined, {
    staticNetwork: true, // skips ethers' eth_chainId detection round-trip
  });
  return lazyProvider;
}

/** Test seam — the house `__reset*` convention. */
export function __resetLinkBalanceForTests(): void {
  lastWarnedAt = 0;
  announcedUnconfigured = false;
  lazyProvider = null;
}

/** Release the lazy provider on shutdown (no-op if never built). */
export function disposeLinkBalance(): void {
  lazyProvider?.destroy();
  lazyProvider = null;
}

export interface LinkBalanceResult {
  checked: boolean;
  /** Human LINK amount, e.g. "4.5". Null when not checked. */
  balance: string | null;
  low: boolean;
  reason?: string;
}

/**
 * One balance read. Never throws — an RPC hiccup must not take down the keeper
 * cron that carries it.
 *
 * `now` is injectable so the re-warn window is testable without fake timers.
 */
export async function checkLinkBalance(
  opts: { provider?: JsonRpcProvider; now?: number } = {},
): Promise<LinkBalanceResult> {
  const now = opts.now ?? Date.now();
  const token = env.LINK_TOKEN_ADDRESS;
  const admin = env.CHAINLINK_UPKEEP_ADMIN;

  if (!token || !admin) {
    if (!announcedUnconfigured) {
      announcedUnconfigured = true;
      console.log(
        "[worker] LINK-balance check skipped — set LINK_TOKEN_ADDRESS and " +
          "CHAINLINK_UPKEEP_ADMIN once the Chainlink upkeep is registered " +
          "(contracts/script/RegisterUpkeep.md)",
      );
    }
    return { checked: false, balance: null, low: false, reason: "unconfigured" };
  }

  let balance: string;
  try {
    const link = new Contract(token, ERC20_BALANCE_ABI, opts.provider ?? providerFor());
    const raw = (await link.balanceOf!(admin)) as bigint;
    balance = formatUnits(raw, 18);
  } catch (err) {
    captureError(err, { while: "link-balance", token, admin });
    return { checked: false, balance: null, low: false, reason: "rpc-error" };
  }

  const low = Number(balance) < env.LINK_BALANCE_WARN;
  if (low && now - lastWarnedAt >= REWARN_MS) {
    lastWarnedAt = now;
    await keeperLinkLow(balance, env.LINK_BALANCE_WARN);
  }
  return { checked: true, balance, low };
}
