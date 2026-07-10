import { afterEach, describe, expect, it, vi } from "vitest";
import { pollToTerminal, TERMINAL, type TransactionSource } from "./lifecycle";

/** A getTransaction that yields the given statuses in order (repeating the last). */
function source(statuses: number[]): TransactionSource {
  let i = 0;
  return {
    getTransaction: () =>
      Promise.resolve({ status: statuses[Math.min(i++, statuses.length - 1)] }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pollToTerminal", () => {
  it("exposes the documented terminal bounds", () => {
    expect(TERMINAL).toEqual({ FINISHED: 7, REFUND_MIN: 8, REFUND_MAX: 11 });
  });

  it("returns finished on FINISHED (7), with the raw payload", async () => {
    const res = await pollToTerminal(source([7]), "tx");
    expect(res.outcome).toBe("finished");
    expect(res.t.status).toBe(7);
  });

  it.each([8, 9, 10, 11])(
    "classifies refund status %i as refunded (funds returned — not success, not plain failure)",
    async (status) => {
      const res = await pollToTerminal(source([status]), "tx");
      expect(res.outcome).toBe("refunded");
      expect(res.t.status).toBe(status);
    },
  );

  it("polls through non-terminal statuses until FINISHED", async () => {
    vi.useFakeTimers();
    const promise = pollToTerminal(source([0, 1, 5, 7]), "tx", {
      intervalMs: 1000,
      timeoutMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(4000);
    const res = await promise;
    expect(res.outcome).toBe("finished");
    expect(res.t.status).toBe(7);
  });

  it.each([6, 12])(
    "treats status %i as NON-terminal (outside 7 and 8–11) and keeps polling",
    async (status) => {
      vi.useFakeTimers();
      const promise = pollToTerminal(source([status]), "tx", {
        intervalMs: 1000,
        timeoutMs: 2000,
      });
      await vi.advanceTimersByTimeAsync(5000);
      const res = await promise;
      expect(res.outcome).toBe("timeout");
      expect(res.t.status).toBe(status);
    },
  );

  it("returns timeout when a terminal status never arrives", async () => {
    vi.useFakeTimers();
    const promise = pollToTerminal(source([5]), "tx", {
      intervalMs: 2000,
      timeoutMs: 6000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await promise;
    expect(res.outcome).toBe("timeout");
    expect(res.t.status).toBe(5);
  });
});
