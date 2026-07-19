import { describe, expect, it } from "vitest";
import {
  CONFIRMATIONS_REQUIRED,
  drawdownPct,
  evaluateDrawdown,
  JUMP_GUARD_PCT,
  MIN_CONFIRM_SPAN_MS,
  MIN_PEAK_AGE_MS,
  MIN_PEAK_USD,
  nextArmedState,
  peakFromSnapshots,
  TRIGGER_COOLDOWN_MS,
  type DrawdownInput,
} from "./drawdown";

const NOW = Date.UTC(2026, 6, 18, 15, 0);
const OLD_PEAK_AT = NOW - MIN_PEAK_AGE_MS - 60_000;

/** A healthy baseline: $100 peak, $80 now = 20% down, threshold 15%. */
function input(over: Partial<DrawdownInput> = {}): DrawdownInput {
  return {
    thresholdPct: 15,
    peak: { valueUsd: 100, atMs: OLD_PEAK_AT },
    current: { valueUsd: 80, markUsd: 80, stale: false },
    previousObservation: { markUsd: 82, atMs: NOW - 60_000 },
    armed: { firstAtMs: NOW - MIN_CONFIRM_SPAN_MS - 1, confirmations: CONFIRMATIONS_REQUIRED - 1 },
    lastTriggerAtMs: null,
    nowMs: NOW,
    ...over,
  };
}

describe("drawdownPct", () => {
  it("measures the fall from peak, and floors at zero above it", () => {
    expect(drawdownPct(100, 85)).toBeCloseTo(15);
    expect(drawdownPct(100, 100)).toBe(0);
    expect(drawdownPct(100, 120)).toBe(0); // above peak is not a negative drawdown
  });

  it("is safe on a zero or negative peak rather than dividing by it", () => {
    expect(drawdownPct(0, 50)).toBe(0);
    expect(drawdownPct(-1, 50)).toBe(0);
  });
});

describe("the happy path", () => {
  it("fires once the crossing is confirmed enough times and for long enough", () => {
    const v = evaluateDrawdown(input());
    expect(v.state).toBe("fire");
    if (v.state === "fire") {
      expect(v.drawdownPct).toBeCloseTo(20);
      expect(v.peakUsd).toBe(100);
      expect(v.currentUsd).toBe(80);
    }
  });

  it("reports 'below' while the holding is above the threshold", () => {
    const v = evaluateDrawdown(input({ current: { valueUsd: 95, markUsd: 95, stale: false } }));
    expect(v.state).toBe("below");
  });

  it("treats the threshold as inclusive — exactly 15% down fires", () => {
    const v = evaluateDrawdown(input({ current: { valueUsd: 85, markUsd: 85, stale: false } }));
    expect(v.state).toBe("fire");
  });
});

describe("a misbehaving feed degrades to INACTION, never to action", () => {
  it("a stale mark can never fire — a feed outage is not a drawdown", () => {
    const v = evaluateDrawdown(input({ current: { valueUsd: 10, markUsd: 10, stale: true } }));
    expect(v.state).toBe("unusable");
    if (v.state === "unusable") expect(v.reason).toBe("stale-mark");
  });

  it("a single poisoned tick is UNUSABLE, not a trigger (the Ostium signature)", () => {
    // The attacker delivered a fabricated $5,000 BTC print. A mark that leaps
    // past the guard is exactly that shape.
    const v = evaluateDrawdown(
      input({
        current: { valueUsd: 1, markUsd: 1, stale: false },
        previousObservation: { markUsd: 82, atMs: NOW - 60_000 },
      }),
    );
    expect(v.state).toBe("unusable");
    if (v.state === "unusable") expect(v.reason).toBe("jump-guard");
  });

  it("a move just inside the jump guard is still judged normally", () => {
    const prev = 100;
    const justInside = prev * (1 - (JUMP_GUARD_PCT - 1) / 100);
    const v = evaluateDrawdown(
      input({
        peak: { valueUsd: 100, atMs: OLD_PEAK_AT },
        current: { valueUsd: justInside, markUsd: justInside, stale: false },
        previousObservation: { markUsd: prev, atMs: NOW - 60_000 },
      }),
    );
    expect(v.state).toBe("fire");
  });

  it("with no previous observation the jump guard cannot run, so it does not block", () => {
    const v = evaluateDrawdown(input({ previousObservation: null }));
    expect(v.state).toBe("fire");
  });

  it("a zero previous mark cannot divide the guard by zero", () => {
    const v = evaluateDrawdown(
      input({ previousObservation: { markUsd: 0, atMs: NOW - 60_000 } }),
    );
    expect(v.state).toBe("fire");
  });
});

describe("peak hygiene", () => {
  it("no peak means no judgement", () => {
    const v = evaluateDrawdown(input({ peak: null }));
    expect(v.state).toBe("unusable");
    if (v.state === "unusable") expect(v.reason).toBe("no-peak");
  });

  it("a freshly minted peak cannot anchor a drawdown", () => {
    const v = evaluateDrawdown(input({ peak: { valueUsd: 100, atMs: NOW - 1000 } }));
    expect(v.state).toBe("unusable");
    if (v.state === "unusable") expect(v.reason).toBe("peak-too-young");
  });

  it("a dust-sized peak cannot manufacture a trigger out of rounding", () => {
    const v = evaluateDrawdown(
      input({
        peak: { valueUsd: MIN_PEAK_USD - 1, atMs: OLD_PEAK_AT },
        current: { valueUsd: 1, markUsd: 1, stale: false },
        previousObservation: null,
      }),
    );
    expect(v.state).toBe("unusable");
    if (v.state === "unusable") expect(v.reason).toBe("peak-too-small");
  });
});

describe("N-of-M confirmation", () => {
  it("a first crossing arms rather than fires", () => {
    const v = evaluateDrawdown(input({ armed: null }));
    expect(v.state).toBe("arming");
    if (v.state === "arming") expect(v.confirmations).toBe(1);
  });

  it("enough confirmations but too little elapsed time still only arms", () => {
    // Three fast reads inside a minute prove nothing about a briefly-wrong feed.
    const v = evaluateDrawdown(
      input({ armed: { firstAtMs: NOW - 1000, confirmations: CONFIRMATIONS_REQUIRED - 1 } }),
    );
    expect(v.state).toBe("arming");
  });

  it("enough elapsed time but too few confirmations still only arms", () => {
    const v = evaluateDrawdown(
      input({ armed: { firstAtMs: NOW - MIN_CONFIRM_SPAN_MS - 1, confirmations: 0 } }),
    );
    expect(v.state).toBe("arming");
  });

  it("counts up across successive scans until both conditions hold", () => {
    let armed = null as ReturnType<typeof nextArmedState>;
    const first = NOW;
    for (let i = 0; i < CONFIRMATIONS_REQUIRED - 1; i++) {
      const at = first + i * 60_000;
      const v = evaluateDrawdown(input({ armed, nowMs: at, peak: { valueUsd: 100, atMs: at - MIN_PEAK_AGE_MS - 1 } }));
      expect(v.state).toBe("arming");
      armed = nextArmedState(v, armed, at);
    }
    const finalAt = first + MIN_CONFIRM_SPAN_MS + 1;
    const v = evaluateDrawdown(
      input({ armed, nowMs: finalAt, peak: { valueUsd: 100, atMs: finalAt - MIN_PEAK_AGE_MS - 1 } }),
    );
    expect(v.state).toBe("fire");
  });
});

describe("cooldown", () => {
  it("stays quiet for the cooldown window after a fire", () => {
    const v = evaluateDrawdown(input({ lastTriggerAtMs: NOW - 1000 }));
    expect(v.state).toBe("unusable");
    if (v.state === "unusable") expect(v.reason).toBe("cooling-down");
  });

  it("can fire again once the window has passed", () => {
    const v = evaluateDrawdown(input({ lastTriggerAtMs: NOW - TRIGGER_COOLDOWN_MS - 1 }));
    expect(v.state).toBe("fire");
  });
});

describe("nextArmedState", () => {
  it("clears on 'below' — a recovery resets the count", () => {
    expect(nextArmedState({ state: "below", drawdownPct: 2 }, { firstAtMs: 1, confirmations: 2 }, NOW))
      .toBeNull();
  });

  it("clears on 'fire' so the next drawdown starts fresh", () => {
    const fired = { state: "fire", drawdownPct: 20, peakUsd: 100, currentUsd: 80, peakAtMs: 1 } as const;
    expect(nextArmedState(fired, { firstAtMs: 1, confirmations: 3 }, NOW)).toBeNull();
  });

  it("KEEPS the armed state on 'unusable' — one unreadable scan must not reset progress", () => {
    const armed = { firstAtMs: 1, confirmations: 2 };
    expect(nextArmedState({ state: "unusable", reason: "stale-mark" }, armed, NOW)).toBe(armed);
  });

  it("preserves the original firstAtMs while arming, so the span keeps accruing", () => {
    const armed = { firstAtMs: 500, confirmations: 1 };
    const next = nextArmedState({ state: "arming", drawdownPct: 20, confirmations: 2 }, armed, NOW);
    expect(next).toEqual({ firstAtMs: 500, confirmations: 2 });
  });
});

describe("peakFromSnapshots", () => {
  const rows = [
    { perAssetJson: { tslax: { valueUsd: 100 } }, atMs: 1000 },
    { perAssetJson: { tslax: { valueUsd: 140 } }, atMs: 2000 },
    { perAssetJson: { tslax: { valueUsd: 120 } }, atMs: 3000 },
  ];

  it("finds the maximum and the time it occurred", () => {
    expect(peakFromSnapshots(rows, "tslax")).toEqual({ valueUsd: 140, atMs: 2000 });
  });

  it("returns null for an asset that never appears", () => {
    expect(peakFromSnapshots(rows, "spyx")).toBeNull();
    expect(peakFromSnapshots([], "tslax")).toBeNull();
  });

  it("ignores malformed, missing, zero and non-finite entries (payload_json is jsonb)", () => {
    const junk = [
      { perAssetJson: null, atMs: 1 },
      { perAssetJson: {}, atMs: 2 },
      { perAssetJson: { tslax: {} }, atMs: 3 },
      { perAssetJson: { tslax: { valueUsd: "90" } }, atMs: 4 },
      { perAssetJson: { tslax: { valueUsd: 0 } }, atMs: 5 },
      { perAssetJson: { tslax: { valueUsd: Number.NaN } }, atMs: 6 },
      { perAssetJson: { tslax: { valueUsd: 42 } }, atMs: 7 },
    ];
    expect(peakFromSnapshots(junk, "tslax")).toEqual({ valueUsd: 42, atMs: 7 });
  });
});

describe("the guards are ordered so the safest answer always wins", () => {
  it("a stale mark beats every other condition, including a real crossing", () => {
    const v = evaluateDrawdown(
      input({ current: { valueUsd: 1, markUsd: 1, stale: true }, peak: null }),
    );
    expect(v.state).toBe("unusable");
    if (v.state === "unusable") expect(v.reason).toBe("stale-mark");
  });

  it("NO input combination can produce 'fire' from a stale mark", () => {
    for (const valueUsd of [0, 1, 50, 80, 200]) {
      for (const lastTriggerAtMs of [null, NOW - 1]) {
        const v = evaluateDrawdown(
          input({ current: { valueUsd, markUsd: valueUsd, stale: true }, lastTriggerAtMs }),
        );
        expect(v.state).not.toBe("fire");
      }
    }
  });
});
