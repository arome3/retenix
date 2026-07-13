import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SUMMARY_CACHE_TTL_MS,
  DUST_FLOOR_USD,
  NETWORK_NAMES,
  SWEEP_PROMPT_THRESHOLD_USD,
  networkName,
  sweepExecutePayloadSchema,
  sweepPromptCopy,
  sweepReceiptHeadline,
} from "./sweep";

describe("PROPOSED constants (doc 06 — exact documented values, not tuned)", () => {
  it("dust floor $0.25, prompt threshold $1, cache 30s", () => {
    expect(DUST_FLOOR_USD).toBe(0.25);
    expect(SWEEP_PROMPT_THRESHOLD_USD).toBe(1);
    expect(ACCOUNT_SUMMARY_CACHE_TTL_MS).toBe(30_000);
  });
});

describe("NETWORK_NAMES (G3: exactly six networks)", () => {
  it("carries exactly the six UA v2 chain ids", () => {
    // Mirror of @retenix/ua RETENIX_CHAIN_IDS — shared is a leaf package, so the
    // ids are pinned here a second time to catch silent drift.
    expect(Object.keys(NETWORK_NAMES).map(Number).sort((a, b) => a - b)).toEqual([
      1, 56, 101, 196, 8453, 42161,
    ]);
  });

  it("names each network for receipts/breakdown", () => {
    expect(networkName(1)).toBe("Ethereum");
    expect(networkName(56)).toBe("BSC");
    expect(networkName(8453)).toBe("Base");
    expect(networkName(196)).toBe("X Layer");
    expect(networkName(42161)).toBe("Arbitrum");
    expect(networkName(101)).toBe("Solana");
  });

  it("falls back to a canon-safe label for unknown ids", () => {
    expect(networkName(7777)).toBe("Source 7777");
  });
});

describe("canonical copy (CONFLICTS.md #9 — verbatim, interpolated)", () => {
  it("prompt copy matches the canonical decision-surface string", () => {
    expect(sweepPromptCopy(23.11, 5)).toBe(
      "We found $23.11 in 5 places. Add it to your buying power?",
    );
  });

  it("prompt copy handles a single place grammatically (count is live, 1–6)", () => {
    expect(sweepPromptCopy(1.05, 1)).toBe(
      "We found $1.05 in 1 place. Add it to your buying power?",
    );
  });

  it("prompt copy displays the zeros (USD always two decimals)", () => {
    expect(sweepPromptCopy(5, 2)).toBe(
      "We found $5.00 in 2 places. Add it to your buying power?",
    );
  });

  it("receipt headline matches the canonical receipt string", () => {
    expect(sweepReceiptHeadline(23.11, 5)).toBe("+$23.11 rescued from 5 networks.");
  });

  it("receipt headline handles a single network grammatically", () => {
    expect(sweepReceiptHeadline(0.9, 1)).toBe("+$0.90 rescued from 1 network.");
  });
});

describe("sweepExecutePayloadSchema (the signed wire shape)", () => {
  it("accepts an authorize payload", () => {
    expect(sweepExecutePayloadSchema.parse({ phase: "authorize" })).toEqual({
      phase: "authorize",
    });
  });

  it("accepts a report payload with legs", () => {
    const payload = {
      phase: "report",
      executionId: "0d5c1f9a-8f2b-4c39-9a55-8e29a1f4b7c1",
      legs: [
        {
          chainId: 8453,
          token: "0x1111111111111111111111111111111111111111",
          transactionId: "tx_abc",
          clientOutcome: "finished",
          feesQuoted: { gas: 0.01, service: 0.02, lp: 0, total: 0.03 },
        },
        {
          chainId: 101,
          token: "So11111111111111111111111111111111111111112",
          clientOutcome: "failed",
          error: "quote expired",
        },
      ],
    };
    expect(sweepExecutePayloadSchema.parse(payload)).toEqual(payload);
  });

  it("rejects a report without a valid executionId", () => {
    expect(() =>
      sweepExecutePayloadSchema.parse({ phase: "report", executionId: "nope", legs: [] }),
    ).toThrow();
  });

  it("rejects unknown phases (discriminated union is closed)", () => {
    expect(() => sweepExecutePayloadSchema.parse({ phase: "sweep-it-all" })).toThrow();
  });

  it("rejects oversized leg lists (64 max)", () => {
    const legs = Array.from({ length: 65 }, (_, i) => ({
      chainId: 1,
      token: `0x${String(i).padStart(40, "0")}`,
      clientOutcome: "failed" as const,
    }));
    expect(() =>
      sweepExecutePayloadSchema.parse({
        phase: "report",
        executionId: "0d5c1f9a-8f2b-4c39-9a55-8e29a1f4b7c1",
        legs,
      }),
    ).toThrow();
  });
});
