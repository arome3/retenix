// Settle-chain RPC reads (doc 15) — block-number pin at authorize + the
// Transfer-log scan behind the recipient's receipt. Split into its own module
// so router tests can mock the network edge (the kill.test.ts convention).
import { JsonRpcProvider } from "ethers";
import { env } from "@/env";

let provider: JsonRpcProvider | null = null;
function settleProvider(): JsonRpcProvider {
  // Sends settle on Arbitrum (doc 15 PROPOSED default) — RetenixPolicy's home.
  provider ??= new JsonRpcProvider(env.RPC_URL_ARBITRUM, undefined, {
    staticNetwork: true,
  });
  return provider;
}

export function getSettleBlockNumber(): Promise<number> {
  return settleProvider().getBlockNumber();
}

export async function getSettleLogs(filter: {
  address: string;
  topics: (string | null)[];
  fromBlock: number;
  toBlock: "latest";
}): Promise<{ data: string }[]> {
  const logs = await settleProvider().getLogs(filter);
  return logs.map((l) => ({ data: l.data }));
}
