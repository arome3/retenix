import { describe, expect, it } from "vitest";

import { executionRef, keeperDeadlineFired, keeperLinkLow, smokeResult } from "./notify";

describe("executionRef (doc 17: every message links the execution row and the tx)", () => {
  const EXEC = "9f1b0a3e-6f9c-4f6a-9b8e-9d0f3a2b1c4d";
  const PLAN = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  const TX = "0x" + "9f".repeat(32);

  it("carries the execution row, the plan, and a clickable tx", () => {
    const ref = executionRef({ executionId: EXEC, planId: PLAN, uaTxId: TX });
    expect(ref).toContain(EXEC);
    expect(ref).toContain(PLAN);
    expect(ref).toContain(`https://universalx.app/activity/details?id=${TX}`);
  });

  // Blocked receipts never reach the UA — the revert happens at step 4, before
  // any send — so there is no tx to link and the message must not pretend.
  it("omits the tx when there is none (a blocked receipt has no send)", () => {
    const ref = executionRef({ executionId: EXEC, planId: PLAN });
    expect(ref).toContain(EXEC);
    expect(ref).not.toContain("universalx.app");
  });

  it("omits the execution row before one exists", () => {
    expect(executionRef({ planId: PLAN })).not.toContain("execution");
  });

  it("is empty rather than a dangling dash when nothing is known", () => {
    expect(executionRef({})).toBe("");
  });
});

describe("message shapes", () => {
  // The daily convert runs in a GitHub runner and cannot call notify.ts, so
  // mainnet-smoke.yml restates this format in curl. Pinning it here is what
  // makes "keep the two in step" checkable rather than aspirational.
  it("smokeResult distinguishes green from red unmistakably", () => {
    const green = smokeResult(true, "1", "https://gh/run/1");
    const red = smokeResult(false, "1", "https://gh/run/1");
    expect(green).toContain("green");
    expect(green).toContain("$1");
    expect(red).toContain("RED");
    expect(red).toContain("STOP feature work");
    expect(red).toContain("https://gh/run/1");
  });

  it("keeper triggers name the owner and the actionable fact", async () => {
    const posted: string[] = [];
    const spy = { log: console.log };
    console.log = (msg: string) => void posted.push(String(msg));
    try {
      // The placeholder webhook makes slack() log instead of posting.
      await keeperDeadlineFired("0xowner", "0xdeadbeef");
      await keeperLinkLow("0.5", 2);
    } finally {
      console.log = spy.log;
    }
    const all = posted.join("\n");
    expect(all).toContain("0xowner");
    expect(all).toContain("challenge window");
    expect(all).toContain("0.5");
    expect(all).toContain("deadline stops firing");
  });
});
