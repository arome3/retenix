import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CADENCE_PERIOD_SECS,
  advanceSchedule,
  effectiveSpent,
  nextCadenceRun,
  periodOf,
} from "./period";

// ---------------------------------------------------------------------------
// Cross-impl vectors — the SAME file contracts/test/PeriodVectors.t.sol
// drives the real RetenixPolicy bytecode with (doc 07 fixture pattern).
// ---------------------------------------------------------------------------

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../contracts/test/fixtures/period-vectors.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  count: number;
  vectors: {
    name: string;
    anchor: number;
    periodSecs: number;
    now: number;
    expectedPeriodStart: number;
  }[];
};

describe("periodOf ↔ Solidity rollover vectors", () => {
  it("fixture is intact", () => {
    expect(fixture.vectors).toHaveLength(fixture.count);
  });

  it.each(fixture.vectors)("$name", (v) => {
    expect(
      periodOf({ periodStart: v.anchor, periodSecs: v.periodSecs }, v.now)
        .periodStart,
    ).toBe(v.expectedPeriodStart);
  });
});

// ---------------------------------------------------------------------------
// Mirrors of contracts/test/PeriodRollover.t.sol (PERIOD = 1000)
// ---------------------------------------------------------------------------

describe("periodOf — PeriodRollover.t.sol mirror", () => {
  const t0 = 1_700_000_000;
  const P = 1000;
  const at = (now: number) => periodOf({ periodStart: t0, periodSecs: P }, now);

  it("stays within the period at its last second", () => {
    expect(at(t0 + P - 1).periodStart).toBe(t0);
  });
  it("boundary-exact timestamp rolls (spec >=)", () => {
    expect(at(t0 + P).periodStart).toBe(t0 + P);
  });
  it("multi-period gap snaps phase-aligned, not to now", () => {
    expect(at(t0 + 2 * P + 500).periodStart).toBe(t0 + 2 * P);
  });
  it("uint32-max periodSecs does not overflow the boundary math", () => {
    const huge = 4_294_967_295; // type(uint32).max
    expect(
      periodOf({ periodStart: t0, periodSecs: huge }, t0 + 365 * 86_400)
        .periodStart,
    ).toBe(t0);
  });
  it("rejects a zero period (contract guards ZeroPeriod)", () => {
    expect(() => periodOf({ periodStart: t0, periodSecs: 0 }, t0)).toThrow(
      /periodSecs/,
    );
  });

  it("fuzz: periodStart always phase-aligned and now inside its window", () => {
    // Deterministic LCG (no Math.random in tests — reproducible failures).
    let seed = 0x5eed;
    const rnd = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let i = 0; i < 500; i += 1) {
      const periodSecs = 1 + Math.floor(rnd() * 604_800);
      const gap = Math.floor(rnd() * 10 * periodSecs);
      const { periodStart } = periodOf({ periodStart: t0, periodSecs }, t0 + gap);
      expect((periodStart - t0) % periodSecs).toBe(0);
      expect(periodStart).toBeLessThanOrEqual(t0 + gap);
      expect(periodStart + periodSecs).toBeGreaterThan(t0 + gap);
    }
  });
});

describe("effectiveSpent", () => {
  const p = { periodStart: 1_700_000_000, periodSecs: 1000, spentInPeriod: 30_000_000n };
  it("keeps spent inside the window (last second inclusive)", () => {
    expect(effectiveSpent(p, 1_700_000_999)).toBe(30_000_000n);
  });
  it("zeroes spent once the window rolls (boundary-exact)", () => {
    expect(effectiveSpent(p, 1_700_001_000)).toBe(0n);
    expect(effectiveSpent(p, 1_700_002_500)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// Cadence grid (PROPOSED rules, doc 08: daily = 24h from activation time;
// weekly = same weekday+time; monthly = same day-of-month clamped; all UTC)
// ---------------------------------------------------------------------------

describe("nextCadenceRun", () => {
  const anchor = new Date("2026-01-15T09:30:00.000Z"); // a Thursday

  it("daily: 24h grid from the activation time", () => {
    expect(nextCadenceRun("daily", anchor, anchor).toISOString()).toBe(
      "2026-01-16T09:30:00.000Z",
    );
    // 36h in → next grid point is +48h
    expect(
      nextCadenceRun(
        "daily",
        anchor,
        new Date("2026-01-16T21:30:00.000Z"),
      ).toISOString(),
    ).toBe("2026-01-17T09:30:00.000Z");
  });

  it("weekly: same weekday + time", () => {
    const next = nextCadenceRun("weekly", anchor, new Date(anchor.getTime() + 1));
    expect(next.toISOString()).toBe("2026-01-22T09:30:00.000Z");
    expect(next.getUTCDay()).toBe(anchor.getUTCDay());
  });

  it("monthly: same day-of-month, clamped, without permanent drift", () => {
    const jan31 = new Date("2026-01-31T10:00:00.000Z");
    const feb = nextCadenceRun("monthly", jan31, jan31);
    expect(feb.toISOString()).toBe("2026-02-28T10:00:00.000Z"); // 2026 not a leap year
    const mar = nextCadenceRun("monthly", jan31, feb);
    expect(mar.toISOString()).toBe("2026-03-31T10:00:00.000Z"); // returns to the 31st
    const apr = nextCadenceRun("monthly", jan31, mar);
    expect(apr.toISOString()).toBe("2026-04-30T10:00:00.000Z");
  });

  it("monthly: leap-year February keeps the 29th", () => {
    const jan31 = new Date("2024-01-31T00:00:00.000Z");
    expect(nextCadenceRun("monthly", jan31, jan31).toISOString()).toBe(
      "2024-02-29T00:00:00.000Z",
    );
  });

  it("from before the anchor returns the anchor itself", () => {
    const early = new Date(anchor.getTime() - 86_400_000);
    expect(nextCadenceRun("daily", anchor, early).toISOString()).toBe(
      anchor.toISOString(),
    );
  });

  it("UTC discipline: a US-DST-transition date does not shift the time", () => {
    const a = new Date("2026-03-07T18:00:00.000Z");
    expect(nextCadenceRun("daily", a, a).toISOString()).toBe(
      "2026-03-08T18:00:00.000Z",
    );
  });
});

describe("advanceSchedule (missed periods roll past without catch-up buys)", () => {
  const anchor = new Date("2026-01-01T12:00:00.000Z");
  const w = (k: number) => new Date(anchor.getTime() + k * 7 * 86_400_000);

  it("normal advance: no misses, next is the following grid point", () => {
    const { next, missed } = advanceSchedule(
      "weekly",
      anchor,
      w(1),
      new Date(w(1).getTime() + 60_000),
    );
    expect(missed).toBe(0);
    expect(next.toISOString()).toBe(w(2).toISOString());
  });

  it("worker down for 15 days: two grid points missed, no batching", () => {
    const now = new Date(w(1).getTime() + 15 * 86_400_000); // between w3 and w4
    const { next, missed } = advanceSchedule("weekly", anchor, w(1), now);
    expect(missed).toBe(2); // w2, w3 — the current run stands in for w1
    expect(next.toISOString()).toBe(w(4).toISOString());
  });

  it("cap windows per cadence stay the PROPOSED constants", () => {
    expect(CADENCE_PERIOD_SECS.daily).toBe(86_400);
    expect(CADENCE_PERIOD_SECS.weekly).toBe(604_800);
    expect(CADENCE_PERIOD_SECS.monthly).toBe(2_592_000);
  });
});
