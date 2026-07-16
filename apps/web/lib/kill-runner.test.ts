// Module 13 — the kill runner's pipeline mechanics. The load-bearing claims:
// sign+send NEVER overlaps (magic.evm.switchChain is global mutable state),
// quote creation overlaps up to the pool width, per-leg failures are reported
// and never sink the batch, and "still settling" terminal claims re-poll.
import type { KillWorkItem } from "@retenix/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@retenix/ua", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@retenix/ua")>();
  return {
    ...actual,
    createUa: vi.fn(() => ({}) as never),
    magicSigner: vi.fn(() => ({}) as never),
    createSellTransaction: vi.fn(),
    createConvertTransaction: vi.fn(),
    parseFeeTotals: vi.fn(() => ({ gas: 0.01, service: 0.01, lp: 0, total: 0.02 })),
    signAndSend: vi.fn(),
    pollToTerminal: vi.fn(),
  };
});
vi.mock("@/lib/magic", () => ({ magic: {} }));
vi.mock("@/lib/sign", () => ({
  personalSign: vi.fn(async () => `0x${"ab".repeat(65)}`),
  signEnvelope: vi.fn(async (_route: string, payload: unknown) => ({
    payload,
    sig: { signature: "0xsig", nonce: 1, expiry: 9999999999 },
  })),
}));
vi.mock("@/lib/trpc-vanilla", () => ({
  trpcVanilla: {
    kill: {
      prepare: { query: vi.fn() },
      execute: { mutate: vi.fn() },
      reportLeg: { mutate: vi.fn() },
      retryLeg: { mutate: vi.fn() },
    },
  },
}));

const ua = await import("@retenix/ua");
const sellMock = vi.mocked(ua.createSellTransaction);
const convertMock = vi.mocked(ua.createConvertTransaction);
const sendMock = vi.mocked(ua.signAndSend);
const pollMock = vi.mocked(ua.pollToTerminal);
const { trpcVanilla } = await import("@/lib/trpc-vanilla");
const prepareMock = vi.mocked(trpcVanilla.kill.prepare.query);
const executeMock = vi.mocked(trpcVanilla.kill.execute.mutate);
const reportMock = vi.mocked(trpcVanilla.kill.reportLeg.mutate);
const retryMock = vi.mocked(trpcVanilla.kill.retryLeg.mutate);

const { createMutex, runPool, runKill, resumeKill, retryKillLeg } = await import(
  "./kill-runner"
);

const EOA = "0x8FdfCbCc3FB3d5Cf971685Fd44a36F7e363d456D";

const sellItem = (legId: string): KillWorkItem => ({
  legId,
  kind: "sell",
  assetId: "spyx",
  symbol: "SPYx",
  chainId: 101,
  token: "XsMint",
  amountHuman: "0.05",
  usdEst: 32,
});
const convertItem = (legId: string): KillWorkItem => ({
  legId,
  kind: "convert",
  assetId: "eth",
  symbol: "ETH",
  chainId: 42161,
  expectUsdc: 9.8,
  primaryType: "eth",
  usdEst: 10,
});

const PREP = {
  needsRevoke: true,
  digest: `0x${"cd".repeat(32)}`,
  nonce: "7",
  activeKillId: null as string | null,
  lastKillId: null as string | null,
};

function executeResponse(workItems: KillWorkItem[], polling: { legId: string; transactionId: string }[] = []) {
  return {
    killId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    resumed: false,
    revoke: { state: "submitted", txHash: "0xr" },
    workItems,
    polling,
    skipped: [],
  } as never;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.clearAllMocks();
  prepareMock.mockResolvedValue(PREP as never);
  pollMock.mockResolvedValue({ outcome: "finished", t: { status: 7 } } as never);
  reportMock.mockResolvedValue({ outcome: "settled" } as never);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createMutex", () => {
  it("serializes: never two sections in flight, order preserved", async () => {
    const locked = createMutex();
    let inFlight = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        locked(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await tick(5);
          order.push(n);
          inFlight -= 1;
        }),
      ),
    );
    expect(peak).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("a throwing section releases the lock for the next", async () => {
    const locked = createMutex();
    await expect(locked(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(locked(async () => "after")).resolves.toBe("after");
  });
});

describe("runPool", () => {
  it("bounds concurrency to the pool width", async () => {
    let inFlight = 0;
    let peak = 0;
    await runPool([1, 2, 3, 4, 5], 2, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight -= 1;
    });
    expect(peak).toBe(2);
  });
});

describe("runKill pipeline", () => {
  it("signs+sends strictly serialized while quote creation overlaps", async () => {
    executeMock.mockResolvedValue(
      executeResponse([sellItem("a"), sellItem("b"), sellItem("c"), sellItem("d")]),
    );
    let creating = 0;
    let createPeak = 0;
    sellMock.mockImplementation(async () => {
      creating += 1;
      createPeak = Math.max(createPeak, creating);
      await tick(10);
      creating -= 1;
      return { rootHash: "0xroot", userOps: [] } as never;
    });
    let sending = 0;
    let sendPeak = 0;
    let sent = 0;
    sendMock.mockImplementation(async () => {
      sending += 1;
      sendPeak = Math.max(sendPeak, sending);
      await tick(5);
      sending -= 1;
      sent += 1;
      return { transactionId: `tx_${sent}00000000` };
    });

    const result = await runKill(EOA, { tapAtMs: Date.now() - 3000 });

    expect(sendPeak).toBe(1); // the switchChain law
    expect(createPeak).toBe(2); // pipelined, bounded by the pool
    expect(result.submitted).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.tapToLastSubmitMs).toBeGreaterThan(0);
  });

  it("continue-and-report: create-throw and sign-throw legs fail alone", async () => {
    executeMock.mockResolvedValue(
      executeResponse([sellItem("a"), sellItem("b"), convertItem("c")]),
    );
    sellMock
      .mockResolvedValueOnce({ rootHash: "0x1", userOps: [] } as never)
      .mockRejectedValueOnce(new Error("quote expired"));
    convertMock.mockResolvedValue({ rootHash: "0x3", userOps: [] } as never);
    sendMock
      .mockResolvedValueOnce({ transactionId: "tx_a_00000000" })
      .mockRejectedValueOnce(new Error("root sig rejected"));

    const result = await runKill(EOA, {});
    expect(result.submitted).toBe(1);
    expect(result.failed).toBe(2);

    await tick(20); // let fire-and-forget reports land
    const failedReports = reportMock.mock.calls.filter(
      ([arg]) => (arg as { phase: string }).phase === "failed",
    );
    expect(failedReports).toHaveLength(2);
    const submittedReports = reportMock.mock.calls.filter(
      ([arg]) => (arg as { phase: string }).phase === "submitted",
    );
    expect(submittedReports).toHaveLength(1);
  });

  it("heals a raced authNonce with ONE fresh prepare + re-sign", async () => {
    executeMock
      .mockRejectedValueOnce(
        Object.assign(new Error("authorization expired — re-prepare and sign again"), {
          data: { code: "BAD_REQUEST" },
        }),
      )
      .mockResolvedValueOnce(executeResponse([sellItem("a")]));
    sellMock.mockResolvedValue({ rootHash: "0x1", userOps: [] } as never);
    sendMock.mockResolvedValue({ transactionId: "tx_heal_000001" });

    const result = await runKill(EOA, {});
    expect(result.submitted).toBe(1);
    expect(prepareMock).toHaveBeenCalledTimes(2);
  });

  it("resumes polling for already-submitted legs without re-sending them", async () => {
    prepareMock.mockResolvedValue({ ...PREP, needsRevoke: false, activeKillId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff" } as never);
    executeMock.mockResolvedValue(
      executeResponse([], [{ legId: "x", transactionId: "tx_resume_00001" }]),
    );

    const result = await resumeKill(EOA);
    expect(result?.total).toBe(1);
    expect(sendMock).not.toHaveBeenCalled(); // never re-send a live tx

    await tick(20);
    const terminals = reportMock.mock.calls.filter(
      ([arg]) => (arg as { phase: string }).phase === "terminal",
    );
    expect(terminals).toHaveLength(1);
  });

  it("resumeKill is a no-op when nothing is active", async () => {
    prepareMock.mockResolvedValue({ ...PREP, activeKillId: null } as never);
    expect(await resumeKill(EOA)).toBeNull();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("'still settling' terminal claims re-poll until the server accepts", async () => {
    vi.useFakeTimers();
    executeMock.mockResolvedValue(executeResponse([sellItem("a")]));
    sellMock.mockResolvedValue({ rootHash: "0x1", userOps: [] } as never);
    sendMock.mockResolvedValue({ transactionId: "tx_settle_00001" });
    const conflict = Object.assign(new Error("still settling"), {
      data: { code: "CONFLICT" },
    });
    reportMock
      .mockResolvedValueOnce({ outcome: "submitted" } as never) // the submitted claim
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ outcome: "settled" } as never);

    await runKill(EOA, {});
    await vi.advanceTimersByTimeAsync(10_000); // pump the re-poll waits

    const terminals = reportMock.mock.calls.filter(
      ([arg]) => (arg as { phase: string }).phase === "terminal",
    );
    expect(terminals).toHaveLength(3); // two CONFLICTs + the accepted claim
  });
});

describe("retryKillLeg", () => {
  it("re-arms via the signed route, runs the leg, and settles it", async () => {
    retryMock.mockResolvedValue({ workItem: sellItem("r"), attempt: 2 } as never);
    sellMock.mockResolvedValue({ rootHash: "0x1", userOps: [] } as never);
    sendMock.mockResolvedValue({ transactionId: "tx_retry_000001" });

    await retryKillLeg(EOA, "6f9619ff-8b86-4d01-b42d-00cf4fc964ff", "r");

    expect(retryMock).toHaveBeenCalledOnce();
    const phases = reportMock.mock.calls.map(([arg]) => (arg as { phase: string }).phase);
    expect(phases).toContain("submitted");
    expect(phases).toContain("terminal");
  });
});
