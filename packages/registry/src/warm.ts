// Token warming (TS-5.6): pre-cache quote routing for the eligible asset set so
// the first buy quote is fast. Called at web session start (post-login) and
// worker boot (doc 08 keeps its call site).
//
// Warming is a pure latency optimization — failures are NON-FATAL. We use
// Promise.allSettled, log rejections, and continue; a failed warm-up costs a few
// hundred ms later, never a thrown error in a hot path.
//
// The `warmUpToken` wrapper comes from @retenix/ua, not the Particle SDK: the SDK
// lives only in packages/ua (check-pins enforces it). The arg shape { chainId,
// address } is the SDK's IBasicToken (confirmed in the 2.0.3 d.ts).
import { warmUpToken, type UniversalAccount } from "@retenix/ua";
import { eligibleAssets } from "./eligible";

export async function warmRegistry(
  ua: UniversalAccount,
  region: string,
): Promise<void> {
  const assets = eligibleAssets(region);
  const results = await Promise.allSettled(
    assets.map((a) =>
      warmUpToken(ua, { chainId: a.chainId, address: a.address }),
    ),
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      const a = assets[i];
      console.warn(
        `[registry] warmUpToken failed for ${a.ticker} (${a.chainId}:${a.address}):`,
        r.reason instanceof Error ? r.reason.message : r.reason,
      );
    }
  });
}
