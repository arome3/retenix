/*
 * The Magic browser SDK — Retenix auth and the user EOA (doc 02).
 *
 * The EOA lives in Magic TEE custody, is user-controlled, is the same address on
 * every EVM endpoint, and is upgraded in place to a Universal Account by doc 03.
 * There is no injected-provider path anywhere in this app: EIP-7702 requires
 * embedded or server keys, so MetaMask and its peers are unsupported by design
 * (G4). No connect button exists, and none may be added.
 *
 * The signing surface other modules consume — reproduce these calls byte-for-byte:
 *
 *   magic.evm.switchChain(chainId)
 *       doc 03 browser 7702 loop
 *   magic.wallet.sign7702Authorization({ contractAddress, chainId, nonce })
 *       doc 03 UA authorization tuples, doc 14 escrow tuples; headless, no popup
 *   magic.rpcProvider.request({ method: "personal_sign", params: [hash, eoa] })
 *       doc 03 rootHash, signedProcedure payloads, doc 14 check-ins; never typed data (G5)
 *   magic.user.revealEVMPrivateKey()
 *       C14 key export; Magic-rendered, user-only modal
 *
 * switchChain must precede sign7702Authorization for that chainId — the order is
 * load-bearing, and this surface neither hides nor reorders it.
 *
 * Magic testnet mode in dev (tech spec §15) comes from the dev dashboard key, not
 * from an SDK flag: the SDK testMode option only short-circuits Magic-link logins
 * and never email OTP, so it would silently break the flow it claims to test.
 */
import { EVMExtension } from "@magic-ext/evm"; // 1.7.0 EXACT (doc 00)
import { Magic, type InstanceWithExtensions, type SDKBase } from "magic-sdk"; // 33.9.0 EXACT (doc 00)
import { clientEnv } from "@/env";
import { DEFAULT_EVM_ENDPOINT, EVM_ENDPOINTS } from "./evm-endpoints";

export type RetenixMagic = InstanceWithExtensions<SDKBase, EVMExtension[]>;

let instance: RetenixMagic | null = null;

/*
 * Lazy client-side singleton. Constructing Magic reaches for window, so this
 * throws by name on the server rather than exploding inside next build.
 */
export function getMagic(): RetenixMagic {
  if (typeof window === "undefined") {
    throw new Error(
      "[magic] browser-only: getMagic() must run in a client component",
    );
  }
  instance ??= new Magic(clientEnv.NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY, {
    network: DEFAULT_EVM_ENDPOINT,
    extensions: [new EVMExtension(EVM_ENDPOINTS)],
  });
  return instance;
}

/*
 * magic.* exactly as doc 02 and its consumers write it. A lazy proxy rather than
 * a bare `new Magic(...)`: the module can then be imported from anywhere, and only
 * touching a property requires a browser.
 */
export const magic: RetenixMagic = new Proxy({} as RetenixMagic, {
  get(_target, prop) {
    const sdk = getMagic();
    const value = Reflect.get(sdk, prop) as unknown;
    return typeof value === "function" ? value.bind(sdk) : value;
  },
});

/* Ends the Magic session. Callers must also clear the server cookie (auth.logout). */
export async function magicLogout(): Promise<void> {
  if (typeof window === "undefined") return;
  await getMagic().user.logout();
}

/* Test seam: drops the memoized instance. */
export function __resetMagicForTests(): void {
  instance = null;
}
