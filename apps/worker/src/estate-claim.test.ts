import { describe, expect, it, vi } from "vitest";
import type { EscrowTuple } from "@retenix/shared";
import { claimOnChain, type ClaimChainIo } from "./estate-claim";

/*
 * The per-chain claim sequence against a fake ClaimChainIo — every trap the
 * G4 rehearsal proved at the protocol level is asserted at the logic level
 * here: silent tuple skip, stale pre-flight, resume-after-partial, one-shot
 * heir conflicts, poison-token isolation.
 */

const OWNER = "0x8FdfCbCc3FB3d5Cf971685Fd44a36F7e363d456D";
const HEIR = "0x609D371A1615d2253E862eB4D95bB3B97323c05E";
// test env: Arbitrum delegate is real, the others are zero
const ARB = 42161;
const ARB_DELEGATE = "0x92427d60cda5f63740d95Ad972dFA5A115AdD8d0";
const DELEGATED = `0xef0100${ARB_DELEGATE.slice(2).toLowerCase()}`;
const ZERO = "0x0000000000000000000000000000000000000000";

function tuple(over: Partial<EscrowTuple> = {}): EscrowTuple {
  return {
    chainId: ARB,
    address: ARB_DELEGATE,
    nonce: 7,
    yParity: 0,
    r: `0x${"11".repeat(32)}`,
    s: `0x${"22".repeat(32)}`,
    ...over,
  };
}

function fakeIo(over: Partial<ClaimChainIo> = {}): ClaimChainIo & {
  applied: number;
  registered: number;
} {
  const state = { applied: 0, registered: 0 };
  const io: ClaimChainIo = {
    getCode: vi.fn(async () => (state.applied > 0 ? DELEGATED : "0x")),
    getTransactionCount: vi.fn(async () => 7),
    heirOf: vi.fn(async () => (state.registered > 0 ? HEIR : ZERO)),
    sendApplyAndRegister: vi.fn(async () => {
      state.applied += 1;
      state.registered += 1;
      return { txHash: "0xapply", status: 1 };
    }),
    sendRegister: vi.fn(async () => {
      state.registered += 1;
      return { txHash: "0xregister", status: 1 };
    }),
    sendClaim: vi.fn(async (_owner, tokens: string[]) => ({
      txHash: "0xclaim",
      claimed: [
        ...tokens.map((t) => ({ token: t, amount: 100n })),
        { token: ZERO, amount: 5n },
      ],
    })),
    ...over,
  };
  return Object.assign(io, state) as never;
}

const scan = {
  chainId: ARB,
  network: "Arbitrum",
  usd: 100,
  tokens: ["0xToken1", "0xToken2"],
  assets: [],
  skips: [],
};

describe("claimOnChain", () => {
  it("skips a chain whose delegate isn't deployed", async () => {
    const res = await claimOnChain({
      io: fakeIo(),
      chainId: 8453, // zero delegate in the test env
      owner: OWNER,
      heir: HEIR,
      tuple: tuple({ chainId: 8453 }),
      scan: null,
    });
    expect(res.state).toBe("skipped");
  });

  it("happy path: apply+register in one Type-4, claim decodes transfers", async () => {
    const io = fakeIo();
    const res = await claimOnChain({ io, chainId: ARB, owner: OWNER, heir: HEIR, tuple: tuple(), scan });
    expect(res.state).toBe("claimed");
    expect(io.sendApplyAndRegister).toHaveBeenCalledOnce();
    expect(io.sendRegister).not.toHaveBeenCalled();
    expect(res.assets).toEqual([
      { token: "0xToken1", amountHuman: "100" },
      { token: "0xToken2", amountHuman: "100" },
      { token: "native", amountHuman: "5" },
    ]);
  });

  it("stale tuple is caught at pre-flight (the dead-man switch)", async () => {
    const io = fakeIo({ getTransactionCount: vi.fn(async () => 9) });
    const res = await claimOnChain({ io, chainId: ARB, owner: OWNER, heir: HEIR, tuple: tuple(), scan });
    expect(res.state).toBe("stale-tuple");
    expect(res.detail).toContain("signed at nonce 7, account is at 9");
    expect(io.sendApplyAndRegister).not.toHaveBeenCalled();
  });

  it("the silent-skip trap: apply tx succeeds but no code lands → stale-tuple", async () => {
    const io = fakeIo({
      getCode: vi.fn(async () => "0x"), // never delegates, even after "success"
      sendApplyAndRegister: vi.fn(async () => ({ txHash: "0xraced", status: 1 })),
    });
    const res = await claimOnChain({ io, chainId: ARB, owner: OWNER, heir: HEIR, tuple: tuple(), scan });
    expect(res.state).toBe("stale-tuple");
    expect(res.txHash).toBe("0xraced");
  });

  it("a live FOREIGN delegation is never overwritten", async () => {
    const io = fakeIo({ getCode: vi.fn(async () => `0xef0100${"99".repeat(20)}`) });
    const res = await claimOnChain({ io, chainId: ARB, owner: OWNER, heir: HEIR, tuple: tuple(), scan });
    expect(res.state).toBe("failed");
    expect(io.sendApplyAndRegister).not.toHaveBeenCalled();
  });

  it("resume: already delegated + heir unset → plain Type-2 register (no tuple burned)", async () => {
    let registered = false;
    const io = fakeIo({
      getCode: vi.fn(async () => DELEGATED),
      heirOf: vi.fn(async () => (registered ? HEIR : ZERO)),
      sendRegister: vi.fn(async () => {
        registered = true;
        return { txHash: "0xresume", status: 1 };
      }),
    });
    const res = await claimOnChain({ io, chainId: ARB, owner: OWNER, heir: HEIR, tuple: null, scan });
    expect(res.state).toBe("claimed");
    expect(io.sendApplyAndRegister).not.toHaveBeenCalled();
    expect(io.sendRegister).toHaveBeenCalledOnce();
  });

  it("a DIFFERENT registered heir is a hard stop", async () => {
    const io = fakeIo({
      getCode: vi.fn(async () => DELEGATED),
      heirOf: vi.fn(async () => "0x1111111111111111111111111111111111111111"),
    });
    const res = await claimOnChain({ io, chainId: ARB, owner: OWNER, heir: HEIR, tuple: null, scan });
    expect(res.state).toBe("failed");
    expect(res.detail).toContain("different heir");
    expect(io.sendClaim).not.toHaveBeenCalled();
  });

  it("no tuple and not delegated → stale-tuple (support path), nothing sent", async () => {
    const io = fakeIo();
    const res = await claimOnChain({ io, chainId: ARB, owner: OWNER, heir: HEIR, tuple: null, scan });
    expect(res.state).toBe("stale-tuple");
    expect(io.sendApplyAndRegister).not.toHaveBeenCalled();
  });

  it("poison token: batch reverts → per-token isolation sweeps the rest", async () => {
    const io = fakeIo({
      getCode: vi.fn(async () => DELEGATED),
      heirOf: vi.fn(async () => HEIR),
      sendClaim: vi.fn(async (_owner, tokens: string[]) => {
        if (tokens.length > 1) throw new Error("batch reverted");
        if (tokens[0] === "0xToken2") throw new Error("blocklisted");
        return {
          txHash: "0xone",
          claimed: tokens.length === 0
            ? [{ token: ZERO, amount: 5n }]
            : [{ token: tokens[0]!, amount: 100n }],
        };
      }),
    });
    const res = await claimOnChain({ io, chainId: ARB, owner: OWNER, heir: HEIR, tuple: null, scan });
    expect(res.state).toBe("claimed");
    expect(res.detail).toContain("1 asset(s) need support follow-up");
    expect(res.assets).toEqual([
      { token: "0xToken1", amountHuman: "100" },
      { token: "native", amountHuman: "5" },
    ]);
  });

  it("tuple chainId/delegate hygiene: mismatches never reach the wire", async () => {
    const io = fakeIo();
    const wrongChain = await claimOnChain({
      io, chainId: ARB, owner: OWNER, heir: HEIR, tuple: tuple({ chainId: 1 }), scan,
    });
    expect(wrongChain.state).toBe("failed");
    const wrongDelegate = await claimOnChain({
      io, chainId: ARB, owner: OWNER, heir: HEIR,
      tuple: tuple({ address: `0x${"77".repeat(20)}` }), scan,
    });
    expect(wrongDelegate.state).toBe("failed");
    expect(io.sendApplyAndRegister).not.toHaveBeenCalled();
  });
});
