import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ENS_TIMEOUT_MS, looksLikeEnsName, resolveEnsName } from "./ens";

describe("looksLikeEnsName", () => {
  it("accepts dot-separated names", () => {
    expect(looksLikeEnsName("ana.eth")).toBe(true);
    expect(looksLikeEnsName("pay.ana.eth")).toBe(true);
    expect(looksLikeEnsName("  ana.eth  ")).toBe(true);
  });
  it("rejects emails, addresses, bare words and malformed dots", () => {
    expect(looksLikeEnsName("ana@example.com")).toBe(false);
    expect(looksLikeEnsName("0x1234abcd")).toBe(false);
    expect(looksLikeEnsName("ana")).toBe(false);
    expect(looksLikeEnsName("ana.")).toBe(false);
    expect(looksLikeEnsName(".eth")).toBe(false);
    expect(looksLikeEnsName("a b.eth")).toBe(false);
  });
});

describe("resolveEnsName", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ENS hit → the resolved address, name normalized first", async () => {
    const getEnsAddress = vi.fn().mockResolvedValue("0x" + "ab".repeat(20));
    // Mixed case normalizes to lowercase per ENSIP-15.
    const out = await resolveEnsName("Ana.ETH", { getEnsAddress });
    expect(out).toBe("0x" + "ab".repeat(20));
    expect(getEnsAddress).toHaveBeenCalledWith({ name: "ana.eth" });
  });

  it("ENS miss (null) → null", async () => {
    expect(
      await resolveEnsName("nobody.eth", {
        getEnsAddress: vi.fn().mockResolvedValue(null),
      }),
    ).toBeNull();
  });

  it("RPC error → null, never a throw", async () => {
    expect(
      await resolveEnsName("ana.eth", {
        getEnsAddress: vi.fn().mockRejectedValue(new Error("rpc down")),
      }),
    ).toBeNull();
  });

  it("invalid name (normalize throws) → null without touching the RPC", async () => {
    const getEnsAddress = vi.fn();
    expect(await resolveEnsName("ana..eth", { getEnsAddress })).toBeNull();
    expect(getEnsAddress).not.toHaveBeenCalled();
  });

  it(`hangs past ${ENS_TIMEOUT_MS} ms → null (the 5 s ceiling)`, async () => {
    const never = new Promise<string>(() => {});
    const pending = resolveEnsName("slow.eth", {
      getEnsAddress: () => never,
    });
    await vi.advanceTimersByTimeAsync(ENS_TIMEOUT_MS + 1);
    expect(await pending).toBeNull();
  });
});
