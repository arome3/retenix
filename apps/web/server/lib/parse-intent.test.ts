import { NoObjectGeneratedError, type generateText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { policyDraftFor } from "@retenix/shared";
import {
  INTENT_MODEL_ID,
  INTENT_TIMEOUT_MS,
  intentModel,
  parseIntent,
} from "./parse-intent";
import { RETENIX_INTENT_SYSTEM } from "./intent-system";

const IDS: [string, ...string[]] = ["spyx", "sol"];

const baseArgs = {
  model: intentModel("sk-ant-test"),
  schema: policyDraftFor(IDS),
  system: RETENIX_INTENT_SYSTEM(IDS),
  prompt: "Invest $25 weekly into SOL",
};

const asGenerate = (fn: unknown) => fn as typeof generateText;

function noObjectError(): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: "response did not match schema",
    response: { id: "resp_1", timestamp: new Date(), modelId: INTENT_MODEL_ID },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    } as never,
    finishReason: "stop",
  });
}

describe("parseIntent (the one model call — G10 shape)", () => {
  it("pins the spec model string", () => {
    expect(INTENT_MODEL_ID).toBe("claude-sonnet-4-5");
  });

  it("returns the validated output and passes the 15 s timeout through", async () => {
    const generate = vi.fn().mockResolvedValue({
      output: { broker: { cadence: "weekly", amountUsd: 25, basket: [] } },
    });
    const outcome = await parseIntent({ ...baseArgs, generate: asGenerate(generate) });

    expect(outcome).toEqual({
      kind: "output",
      raw: { broker: { cadence: "weekly", amountUsd: 25, basket: [] } },
    });
    const call = generate.mock.calls[0][0];
    expect(call.timeout).toBe(INTENT_TIMEOUT_MS);
    expect(call.system).toBe(baseArgs.system);
    expect(call.prompt).toBe(baseArgs.prompt);
    expect(call.output).toBeDefined(); // Output.object spec — never generateObject
  });

  it("maps NoObjectGeneratedError to the no-object outcome (guardrail 5)", async () => {
    const generate = vi.fn().mockRejectedValue(noObjectError());
    await expect(
      parseIntent({ ...baseArgs, generate: asGenerate(generate) }),
    ).resolves.toEqual({ kind: "no-object" });
  });

  it("maps a mocked 15 s timeout abort to unavailable — never a throw", async () => {
    const generate = vi
      .fn()
      .mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    await expect(
      parseIntent({ ...baseArgs, generate: asGenerate(generate) }),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  it("maps an upstream outage to unavailable — never a throw", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("fetch failed"));
    await expect(
      parseIntent({ ...baseArgs, generate: asGenerate(generate) }),
    ).resolves.toEqual({ kind: "unavailable" });
  });
});
