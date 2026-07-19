import { CLAIM_ADDRESSES } from "@retenix/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDelegations,
  decodeDelegate,
  delegationsCache,
  DELEGATIONS_CACHE_TTL_MS,
  type DelegationDeps,
} from "./delegations";

const EOA = "0x8FdfCbCc3FB3d5Cf971685Fd44a36F7e363d456D";
const UA_IMPL = "0x" + "1a".repeat(20);
const CLAIM_ARB = CLAIM_ADDRESSES[42161]; // the one deployed delegate
const UNKNOWN = "0x" + "66".repeat(20);

const designation = (address: string) => `0xef0100${address.slice(2)}`;

function deps(over: Partial<DelegationDeps> = {}): DelegationDeps {
  return {
    getDeployments: vi.fn(async () => [
      { chainId: 42161, isDelegated: true },
      { chainId: 1, isDelegated: false },
    ]),
    getAuthTargets: vi.fn(async () => [{ address: UA_IMPL, nonce: 0, chainId: 42161 }]),
    getCode: vi.fn(async (chainId: number) =>
      chainId === 42161 ? designation(UA_IMPL) : "0x",
    ),
    ...over,
  };
}

beforeEach(() => delegationsCache.clear());

describe("decodeDelegate", () => {
  it("decodes a 7702 designation and rejects everything else", () => {
    expect(decodeDelegate(designation(UA_IMPL))).toBe(UA_IMPL.toLowerCase());
    expect(decodeDelegate("0x")).toBeNull(); // plain EOA
    expect(decodeDelegate("0x6080604052")).toBeNull(); // a real contract
    expect(decodeDelegate("0xef0100abcd")).toBeNull(); // truncated designation
  });
});

describe("buildDelegations", () => {
  it("chain truth names the UA delegate; undelegated chains show —", async () => {
    const res = await buildDelegations(EOA, deps());
    if (res.unavailable) throw new Error("should be available");
    expect(res.rows).toHaveLength(5);
    const arb = res.rows.find((r) => r.chainId === 42161)!;
    expect(arb).toMatchObject({
      network: "Arbitrum",
      delegated: true,
      delegate: { kind: "ua", address: UA_IMPL.toLowerCase() },
    });
    for (const row of res.rows.filter((r) => r.chainId !== 42161)) {
      expect(row.delegated).toBe(false);
      expect(row.delegate).toBeUndefined();
    }
  });

  it("names RetenixClaim from CLAIM_ADDRESSES (the estate-claimed edge)", async () => {
    const res = await buildDelegations(
      EOA,
      deps({
        getCode: vi.fn(async (chainId: number) =>
          chainId === 42161 ? designation(CLAIM_ARB) : "0x",
        ),
      }),
    );
    if (res.unavailable) throw new Error("should be available");
    expect(res.rows.find((r) => r.chainId === 42161)!.delegate).toEqual({
      kind: "claim",
      address: CLAIM_ARB.toLowerCase(),
    });
  });

  it("an unknown delegate is shown honestly by address — never renamed", async () => {
    const res = await buildDelegations(
      EOA,
      deps({
        getCode: vi.fn(async (chainId: number) =>
          chainId === 1 ? designation(UNKNOWN) : "0x",
        ),
      }),
    );
    if (res.unavailable) throw new Error("should be available");
    expect(res.rows.find((r) => r.chainId === 1)!.delegate).toEqual({
      kind: "unknown",
      address: UNKNOWN.toLowerCase(),
    });
  });

  it("a chain whose RPC fails falls back to Particle's index (named as UA, no address)", async () => {
    const res = await buildDelegations(
      EOA,
      deps({
        getCode: vi.fn(async (chainId: number) => {
          if (chainId === 42161) throw new Error("rpc down");
          return "0x";
        }),
      }),
    );
    if (res.unavailable) throw new Error("should be available");
    expect(res.rows.find((r) => r.chainId === 42161)!).toMatchObject({
      delegated: true,
      delegate: { kind: "ua" },
    });
  });

  it("chain truth still answers when Particle's shape is unparseable", async () => {
    const res = await buildDelegations(
      EOA,
      deps({
        getDeployments: vi.fn(async () => ({ nope: true })), // OQ5 drift
        getAuthTargets: vi.fn(async () => null),
      }),
    );
    if (res.unavailable) throw new Error("should be available");
    // the UA impl set is empty, so the delegate is shown as unknown-by-address
    expect(res.rows.find((r) => r.chainId === 42161)!.delegate).toMatchObject({
      kind: "unknown",
    });
  });

  it("no working source for a chain → the WHOLE panel is unavailable (never a partial ✓ list)", async () => {
    const res = await buildDelegations(
      EOA,
      deps({
        getDeployments: vi.fn(async () => {
          throw new Error("particle down");
        }),
        getCode: vi.fn(async (chainId: number) => {
          if (chainId === 56) throw new Error("bsc rpc down");
          return "0x";
        }),
      }),
    );
    expect(res).toEqual({ unavailable: true });
  });
});

describe("delegationsCache (fresh-only — a stale ✓ is a fake ✓)", () => {
  const ok = {
    unavailable: false as const,
    rows: [],
    asOf: new Date().toISOString(),
  };

  it("serves within the TTL, expires after, and NEVER caches unavailable", () => {
    delegationsCache.set("u1", ok, 1_000);
    expect(delegationsCache.fresh("u1", 1_000 + DELEGATIONS_CACHE_TTL_MS - 1)).toBe(ok);
    expect(delegationsCache.fresh("u1", 1_000 + DELEGATIONS_CACHE_TTL_MS)).toBeNull();

    delegationsCache.set("u2", { unavailable: true }, 1_000);
    expect(delegationsCache.fresh("u2", 1_001)).toBeNull();
  });
});
