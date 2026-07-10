// packages/ua/src/ua.ts — construct a Universal Account and read its addresses.
import {
  UniversalAccount,
  UNIVERSAL_ACCOUNT_VERSION,
  type ISmartAccountOptions,
} from "@particle-network/universal-account-sdk";
import { isAddress } from "ethers";

/** Particle dashboard credentials (dashboard.particle.network). Injected by the
 *  caller — browser passes NEXT_PUBLIC_PARTICLE_*; worker passes PARTICLE_*. This
 *  package never reads env itself. */
export interface ParticleCreds {
  projectId: string;
  projectClientKey: string;
  projectAppUuid: string;
}

/**
 * Construct a UA for ANY owner — user (Magic EOA), agent (KMS EOA), or heir. v2.0.3
 * initialization, exact:
 *
 *  - `ownerAddress` lives INSIDE `smartAccountOptions`, never top-level (G2 — the
 *    v2.0.3 breaking change; every stale online example puts it top-level).
 *  - `version` is the exported `UNIVERSAL_ACCOUNT_VERSION` constant = "2.0.1" (the V2
 *    *contract* version). Do NOT confuse it with the 2.0.3 *package* pin, and never
 *    pass the literal — always the constant.
 *  - `useEIP7702: true` — 7702 is the only mode (needs embedded/server keys; MetaMask
 *    unsupported, G4).
 *  - `tradeConfig.slippageBps: 100` — fixed 1%; never widen to force a fill.
 *    `universalGas` was REMOVED in v2 — any example passing it is stale.
 */
export function createUa(opts: {
  ownerAddress: string;
  credentials: ParticleCreds;
}): UniversalAccount {
  const { ownerAddress, credentials } = opts;
  // Fail fast: the SDK silently defaults ownerAddress to "" if it is falsy, which
  // yields a UA bound to the zero owner — a footgun we refuse rather than propagate.
  if (!isAddress(ownerAddress)) {
    throw new Error(
      `createUa: ownerAddress is not a valid EVM address: ${JSON.stringify(ownerAddress)}`,
    );
  }
  const { projectId, projectClientKey, projectAppUuid } = credentials;
  if (!projectId || !projectClientKey || !projectAppUuid) {
    throw new Error(
      "createUa: missing Particle credentials (projectId / projectClientKey / projectAppUuid)",
    );
  }
  return new UniversalAccount({
    projectId,
    projectClientKey,
    projectAppUuid,
    smartAccountOptions: {
      name: "UNIVERSAL",
      version: UNIVERSAL_ACCOUNT_VERSION, // "2.0.1" — the V2 contract version
      ownerAddress, // ⚠ v2.0.3: HERE, not top-level (G2)
      useEIP7702: true,
    },
    tradeConfig: { slippageBps: 100 }, // fixed 1%; universalGas removed in v2
  });
}

export interface UaAddresses {
  /** The Magic/agent EOA — the account itself. */
  eoa: string;
  /** UA on EVM. In 7702 mode this ≙ the EOA address. */
  uaEvm: string;
  /** UA on Solana — a DIFFERENT address (SOLANA_ACCOUNT_INDEX.EIP7702 = 11). SPL
   *  deposits land HERE; never show the EVM address as a Solana deposit target. */
  uaSol: string;
}

/**
 * Resolve the three addresses via `getSmartAccountOptions()` (one Particle RPC round
 * trip, then cached by the SDK instance). doc 03 task 7 persists uaEvm/uaSol onto the
 * users row on first login (see apps/web account.bootstrap).
 */
export async function getAddresses(ua: UniversalAccount): Promise<UaAddresses> {
  const o: ISmartAccountOptions = await ua.getSmartAccountOptions();
  const eoa = o.ownerAddress;
  const uaEvm = o.smartAccountAddress;
  const uaSol = o.solanaSmartAccountAddress;
  if (!eoa || !uaEvm || !uaSol) {
    throw new Error(
      "getAddresses: getSmartAccountOptions() returned incomplete addresses (owner / EVM / Solana)",
    );
  }
  return { eoa, uaEvm, uaSol };
}
