import { describe, expect, it, vi } from "vitest";
import type { UniversalAccount } from "@retenix/ua";
import { eligibleAssets } from "./eligible";
import { warmRegistry } from "./warm";

type Token = { chainId: number; address: string };

// warmRegistry calls the @retenix/ua wrapper warmUpToken(ua, token), which
// delegates to ua.warmUpToken(token). A mock UA exposing only that method is
// enough to observe the calls without touching the Particle SDK.
function makeUa(impl: (t: Token) => Promise<unknown> = async () => "ok") {
  const warmUpToken = vi.fn(impl);
  const ua = { warmUpToken } as unknown as UniversalAccount;
  return { ua, warmUpToken };
}

describe("warmRegistry (TS-5.6, non-fatal token warming)", () => {
  it("warms once per eligible asset in the region", async () => {
    const { ua, warmUpToken } = makeUa();
    await warmRegistry(ua, "DE");
    expect(warmUpToken).toHaveBeenCalledTimes(eligibleAssets("DE").length);
  });

  it("passes the { chainId, address } IBasicToken shape (restricted region → SOL+ETH)", async () => {
    const { ua, warmUpToken } = makeUa();
    await warmRegistry(ua, "US");
    expect(warmUpToken.mock.calls.map((c) => c[0])).toEqual([
      { chainId: 101, address: "0x0000000000000000000000000000000000000000" },
      { chainId: 1, address: "0x0000000000000000000000000000000000000000" },
    ]);
  });

  it("never throws when a warm-up rejects — allSettled swallows, logs, continues", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ua } = makeUa(async ({ chainId }) => {
      if (chainId === 1) throw new Error("boom"); // ETH fails
      return "ok";
    });
    await expect(warmRegistry(ua, "DE")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warms the full universe pre-gate (region '') for the session-start cache", async () => {
    const { ua, warmUpToken } = makeUa();
    await warmRegistry(ua, "");
    expect(warmUpToken).toHaveBeenCalledTimes(eligibleAssets("").length);
  });
});
