// Module 15 — the send runner's pipeline mechanics. Load-bearing claims: the
// transfer is created ONLY against the server-authorized target, the invite
// path never touches the UA, failures still report (so the double-tap guard
// releases), reports retry with fresh envelopes, and a stashed report
// survives a closed tab.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@retenix/ua", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@retenix/ua")>();
  return {
    ...actual,
    createUa: vi.fn(() => ({}) as never),
    magicSigner: vi.fn(() => ({}) as never),
    createTransferTransaction: vi.fn(),
    parseFeeTotals: vi.fn(() => ({ gas: 0.02, service: 0.02, lp: 0.01, total: 0.05 })),
    signAndSend: vi.fn(),
    pollToTerminal: vi.fn(),
  };
});
vi.mock("@/lib/magic", () => ({ magic: {} }));
vi.mock("@/lib/sign", () => ({
  signEnvelope: vi.fn(async (_route: string, payload: unknown) => ({
    payload,
    sig: { signature: "0xsig", nonce: 1, expiry: 9999999999 },
  })),
}));
vi.mock("@/lib/trpc-vanilla", () => ({
  trpcVanilla: { send: { execute: { mutate: vi.fn() } } },
}));

const ua = await import("@retenix/ua");
const transferMock = vi.mocked(ua.createTransferTransaction);
const sendMock = vi.mocked(ua.signAndSend);
const pollMock = vi.mocked(ua.pollToTerminal);
const { trpcVanilla } = await import("@/lib/trpc-vanilla");
const executeMock = vi.mocked(trpcVanilla.send.execute.mutate);
const sign = await import("@/lib/sign");
const envelopeMock = vi.mocked(sign.signEnvelope);
const { quoteSendFees, resumePendingSendReport, runSend } = await import(
  "./send-runner"
);

const EOA = "0x8FdfCbCc3FB3d5Cf971685Fd44a36F7e363d456D";

const TARGET = {
  address: "0x" + "ab".repeat(20),
  token: {
    chainId: 42161,
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    decimals: 6,
    symbol: "USDC",
  },
  amountUnits: "2",
  amountUsd: 2,
  display: "a•••@example.com",
  withdraw: false,
};

const authorizeOk = {
  phase: "authorize" as const,
  authorization: { invited: false as const, executionId: "exec-1", target: TARGET },
};

const receiptOk = {
  phase: "report" as const,
  receipt: {
    executionId: "exec-1",
    receipt: "Sent $2.00 to a•••@example.com · fees $0.05 · view onchain",
    outcome: "finished",
  },
};

// sessionStorage shim (vitest node environment)
const store = new Map<string, string>();
beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("quoteSendFees", () => {
  it("email sends quote with the sender standing in as receiver (advisory)", async () => {
    transferMock.mockResolvedValue({} as never);
    const fees = await quoteSendFees(EOA, {
      token: { chainId: 42161, address: TARGET.token.address },
      amountUnits: "2",
    });
    expect(fees.total).toBe(0.05);
    expect(transferMock).toHaveBeenCalledWith(expect.anything(), {
      token: { chainId: 42161, address: TARGET.token.address },
      amount: "2",
      receiver: EOA,
    });
  });
});

describe("runSend", () => {
  it("happy path: authorize → transfer against the PINNED target → report", async () => {
    executeMock.mockResolvedValueOnce(authorizeOk as never);
    transferMock.mockResolvedValue({ quoted: true } as never);
    sendMock.mockResolvedValue({ transactionId: "tx-1" } as never);
    pollMock.mockResolvedValue({ outcome: "finished", t: {} } as never);
    executeMock.mockResolvedValueOnce(receiptOk as never);

    const stages: string[] = [];
    const res = await runSend(
      EOA,
      { to: { kind: "email", value: "ana@example.com" }, amountUsd: 2 },
      (p) => stages.push(p.stage),
    );

    expect(res).toEqual({
      kind: "sent",
      receipt: receiptOk.receipt.receipt,
      outcome: "finished",
    });
    // the transfer used ONLY authorized values — not client input
    expect(transferMock).toHaveBeenCalledWith(expect.anything(), {
      token: { chainId: 42161, address: TARGET.token.address },
      amount: "2",
      receiver: TARGET.address,
    });
    expect(stages).toEqual(["authorizing", "signing", "settling", "reporting"]);
    // report carried the client poll outcome + quoted fees
    const reportPayload = envelopeMock.mock.calls.at(-1)?.[1] as {
      clientOutcome: string;
      feesQuoted?: { total: number };
    };
    expect(reportPayload.clientOutcome).toBe("finished");
    expect(reportPayload.feesQuoted?.total).toBe(0.05);
    // the stash is cleared after a delivered report
    expect(store.size).toBe(0);
  });

  it("invited: no UA call, the verbatim copy comes back", async () => {
    executeMock.mockResolvedValueOnce({
      phase: "authorize",
      authorization: { invited: true, message: "They don't have Retenix yet — we've invited them. Nothing was sent." },
    } as never);
    const res = await runSend(EOA, {
      to: { kind: "email", value: "stranger@example.com" },
      amountUsd: 2,
    });
    expect(res.kind).toBe("invited");
    expect(transferMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("transfer failure still reports — the double-tap guard releases", async () => {
    executeMock.mockResolvedValueOnce(authorizeOk as never);
    transferMock.mockRejectedValue(new Error("quote expired"));
    executeMock.mockResolvedValueOnce({
      phase: "report",
      receipt: { executionId: "exec-1", receipt: "Didn't complete …", outcome: "failed" },
    } as never);

    const res = await runSend(EOA, {
      to: { kind: "email", value: "ana@example.com" },
      amountUsd: 2,
    });
    expect(res).toEqual({ kind: "failed", message: "quote expired" });
    const reportPayload = envelopeMock.mock.calls.at(-1)?.[1] as {
      phase: string;
      clientOutcome: string;
      transactionId?: string;
    };
    expect(reportPayload).toMatchObject({ phase: "report", clientOutcome: "failed" });
    expect(reportPayload.transactionId).toBeUndefined();
  });

  it("report retries with a FRESH envelope per attempt and converges", async () => {
    executeMock.mockResolvedValueOnce(authorizeOk as never);
    transferMock.mockResolvedValue({} as never);
    sendMock.mockResolvedValue({ transactionId: "tx-2" } as never);
    pollMock.mockResolvedValue({ outcome: "finished", t: {} } as never);
    executeMock
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(receiptOk as never);

    const res = await runSend(EOA, {
      to: { kind: "email", value: "ana@example.com" },
      amountUsd: 2,
    });
    expect(res.kind).toBe("sent");
    // authorize + 2 report attempts = 3 envelopes, all distinct calls
    expect(envelopeMock).toHaveBeenCalledTimes(3);
  });

  it("exhausted reports leave the stash for resume; resume delivers it", async () => {
    executeMock.mockResolvedValueOnce(authorizeOk as never);
    transferMock.mockResolvedValue({} as never);
    sendMock.mockResolvedValue({ transactionId: "tx-3" } as never);
    pollMock.mockResolvedValue({ outcome: "finished", t: {} } as never);
    executeMock.mockRejectedValue(new Error("server down"));

    const res = await runSend(EOA, {
      to: { kind: "email", value: "ana@example.com" },
      amountUsd: 2,
    });
    expect(res.kind).toBe("settling");
    expect(store.has("retenix:send-pending")).toBe(true);

    // next visit: the stashed report goes through
    executeMock.mockReset();
    executeMock.mockResolvedValue(receiptOk as never);
    const resumed = await resumePendingSendReport(EOA);
    expect(resumed).toEqual({
      kind: "sent",
      receipt: receiptOk.receipt.receipt,
      outcome: "finished",
    });
    expect(store.size).toBe(0);

    // nothing pending → null (and no calls)
    executeMock.mockClear();
    expect(await resumePendingSendReport(EOA)).toBeNull();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("a foreign stash is ignored (per-EOA scoping)", async () => {
    store.set(
      "retenix:send-pending",
      JSON.stringify({ eoa: "0x" + "99".repeat(20), executionId: "x", clientOutcome: "finished" }),
    );
    expect(await resumePendingSendReport(EOA)).toBeNull();
  });
}, 20_000);
