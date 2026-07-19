import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetLinkBalanceForTests, checkLinkBalance } from "./link-balance";

const slack = vi.hoisted(() => vi.fn(async () => undefined));
const captureError = vi.hoisted(() => vi.fn());
const keeperLinkLow = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./notify", () => ({ slack, captureError, keeperLinkLow, breadcrumb: vi.fn() }));

// env is parsed at import; override the two optional knobs per test.
const { env } = await import("../env");

/** Minimal ethers-shaped provider: Contract only needs these to build a call. */
function providerReturning(linkWei: bigint | Error) {
  return {
    call: vi.fn(async () => {
      if (linkWei instanceof Error) throw linkWei;
      return "0x" + linkWei.toString(16).padStart(64, "0");
    }),
    getNetwork: vi.fn(async () => ({ chainId: 42161n, name: "arbitrum" })),
    resolveName: vi.fn(async (n: string) => n),
    // ethers v6 Contract checks for a provider by duck-typing these.
    _isProvider: true,
  } as never;
}

const ONE_LINK = 10n ** 18n;

describe("checkLinkBalance", () => {
  beforeEach(() => {
    __resetLinkBalanceForTests();
    slack.mockClear();
    captureError.mockClear();
    keeperLinkLow.mockClear();
    env.LINK_TOKEN_ADDRESS = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4";
    env.CHAINLINK_UPKEEP_ADMIN = "0x562937835cdD5C92F54B94Df658Fd3b50A68ecD5";
    env.LINK_BALANCE_WARN = 2;
  });
  afterEach(() => {
    delete (env as Record<string, unknown>).LINK_TOKEN_ADDRESS;
    delete (env as Record<string, unknown>).CHAINLINK_UPKEEP_ADMIN;
  });

  it("does not alert on an unregistered upkeep — noise is how a real page gets ignored", async () => {
    delete (env as Record<string, unknown>).LINK_TOKEN_ADDRESS;
    const result = await checkLinkBalance({ provider: providerReturning(0n) });
    expect(result).toMatchObject({ checked: false, reason: "unconfigured", low: false });
    expect(keeperLinkLow).not.toHaveBeenCalled();
  });

  it("stays quiet when the balance is healthy", async () => {
    const result = await checkLinkBalance({ provider: providerReturning(5n * ONE_LINK) });
    expect(result).toMatchObject({ checked: true, balance: "5.0", low: false });
    expect(keeperLinkLow).not.toHaveBeenCalled();
  });

  it("alerts below the threshold — the deadline stops firing silently otherwise", async () => {
    const result = await checkLinkBalance({ provider: providerReturning(ONE_LINK / 2n) });
    expect(result).toMatchObject({ checked: true, balance: "0.5", low: true });
    expect(keeperLinkLow).toHaveBeenCalledWith("0.5", 2);
  });

  it("treats the threshold as exclusive (2.0 is not yet low)", async () => {
    await checkLinkBalance({ provider: providerReturning(2n * ONE_LINK) });
    expect(keeperLinkLow).not.toHaveBeenCalled();
  });

  it("re-warns at most hourly — the keeper tick is every 2 minutes", async () => {
    const low = () => providerReturning(ONE_LINK / 2n);
    const t0 = 1_800_000_000_000;

    await checkLinkBalance({ provider: low(), now: t0 });
    await checkLinkBalance({ provider: low(), now: t0 + 60_000 }); // +1 min
    await checkLinkBalance({ provider: low(), now: t0 + 59 * 60_000 }); // +59 min
    expect(keeperLinkLow).toHaveBeenCalledTimes(1);

    await checkLinkBalance({ provider: low(), now: t0 + 60 * 60_000 }); // +60 min
    expect(keeperLinkLow).toHaveBeenCalledTimes(2);
  });

  it("survives an RPC failure without taking down the keeper tick", async () => {
    const result = await checkLinkBalance({
      provider: providerReturning(new Error("upstream 503")),
    });
    expect(result).toMatchObject({ checked: false, reason: "rpc-error", low: false });
    expect(captureError).toHaveBeenCalled();
    expect(keeperLinkLow).not.toHaveBeenCalled();
  });
});
