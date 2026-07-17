import { describe, expect, it } from "vitest";
import {
  absTime,
  fmtDelta,
  fmtPct,
  fmtUsd,
  relTime,
  splitUsd,
  truncAddr,
} from "./format";

// Modern ICU separates the meridiem with U+202F (narrow no-break space).
const TIME_RE = /^\d{1,2}:\d{2}[\s ](AM|PM)$/;

describe("fmtUsd", () => {
  it("always shows two decimals — display the zeros", () => {
    expect(fmtUsd(212.4)).toBe("$212.40");
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(15)).toBe("$15.00");
    expect(fmtUsd(0.005)).toBe("$0.01");
  });

  it("keeps full precision below $100K", () => {
    expect(fmtUsd(99_999.99)).toBe("$99,999.99");
    expect(fmtUsd(-99_999.99)).toBe("-$99,999.99");
  });

  it("abbreviates ≥$100K to 3 significant digits", () => {
    expect(fmtUsd(100_000)).toBe("$100K");
    expect(fmtUsd(123_456)).toBe("$123K");
    expect(fmtUsd(1_240_000)).toBe("$1.24M");
    expect(fmtUsd(1_246_000)).toBe("$1.25M");
    expect(fmtUsd(-1_240_000)).toBe("-$1.24M");
  });
});

describe("fmtPct", () => {
  it("renders to hundredths", () => {
    expect(fmtPct(2.15)).toBe("2.15%");
    expect(fmtPct(0)).toBe("0.00%");
    expect(fmtPct(12.345)).toBe("12.35%");
    expect(fmtPct(1_234.5)).toBe("1,234.50%");
  });
});

describe("fmtDelta", () => {
  it("gains: ▲ with explicit plus", () => {
    expect(fmtDelta(12.4, 2.15)).toBe("▲ +$12.40 (+2.15%)");
  });

  it("losses: ▼ with U+2212 minus, never hyphen-minus", () => {
    const s = fmtDelta(-3.2, -0.85);
    expect(s).toBe("▼ −$3.20 (−0.85%)");
    expect(s).not.toContain("-"); // ASCII hyphen-minus must not appear
  });

  it("zero reads as a gain (▲ +$0.00)", () => {
    expect(fmtDelta(0, 0)).toBe("▲ +$0.00 (+0.00%)");
  });

  it("abbreviates large deltas like any USD amount", () => {
    expect(fmtDelta(1_240_000, 12.5)).toBe("▲ +$1.24M (+12.50%)");
  });
});

describe("truncAddr", () => {
  it("first 6 / last 4 around a single ellipsis", () => {
    expect(
      truncAddr("0x1234abcd5678ef901234abcd5678ef9012345678"),
    ).toBe("0x1234…5678");
    expect(truncAddr("0xAbCd12eF3456789012345678901234567890aBcD")).toBe(
      "0xAbCd…aBcD",
    );
  });

  // doc 15 DoD — edge cases: short strings and non-hex data
  it("strings the ellipsis wouldn't shorten pass through whole", () => {
    expect(truncAddr("")).toBe("");
    expect(truncAddr("0xab")).toBe("0xab");
    expect(truncAddr("0x123456789")).toBe("0x123456789"); // 11 chars — as-is
    expect(truncAddr("0x1234567890ab")).toBe("0x1234…90ab"); // 14 chars — truncates
  });

  it("non-hex data (Solana base58, ENS-ish) truncates by the same rule", () => {
    expect(truncAddr("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(
      "EPjFWd…Dt1v",
    );
    expect(truncAddr("a-long-name-that-is-data.eth")).toBe("a-long….eth");
  });
});

describe("relTime", () => {
  // Fixed midday anchor keeps every boundary away from local-timezone edges.
  const now = new Date(2026, 6, 10, 12, 0, 0); // Jul 10 2026, 12:00 local
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const S = 1_000;
  const M = 60 * S;
  const H = 60 * M;
  const D = 24 * H;

  it("59s → just now", () => {
    expect(relTime(ago(59 * S), now)).toBe("just now");
  });

  it("future timestamps clamp to just now", () => {
    expect(relTime(ago(-5 * S), now)).toBe("just now");
  });

  it("61s → time of day", () => {
    expect(relTime(ago(61 * S), now)).toMatch(TIME_RE);
  });

  it("23h → still time of day", () => {
    expect(relTime(ago(23 * H), now)).toMatch(TIME_RE);
  });

  it("25h → Yesterday at …", () => {
    const s = relTime(ago(25 * H), now);
    expect(s.startsWith("Yesterday at ")).toBe(true);
    expect(s.slice("Yesterday at ".length)).toMatch(TIME_RE);
  });

  it("29d → 29d ago", () => {
    expect(relTime(ago(29 * D), now)).toBe("29d ago");
  });

  it("31d → absolute date", () => {
    expect(relTime(ago(31 * D), now)).toBe("Jun 9, 2026");
  });
});

describe("absTime", () => {
  it("is always absolute — date and time (the tooltip companion)", () => {
    const s = absTime(new Date(2026, 5, 4, 15, 12));
    expect(s.startsWith("Jun 4, 2026")).toBe(true);
    expect(s).toMatch(/3:12[\s ]PM$/);
  });
});

describe("splitUsd (buying-power hero — doc 06 consumes)", () => {
  it("splits dollars from cents below $100K", () => {
    expect(splitUsd(212.4)).toEqual({ main: "$212", cents: "40" });
    expect(splitUsd(0)).toEqual({ main: "$0", cents: "00" });
    expect(splitUsd(4_812.07)).toEqual({ main: "$4,812", cents: "07" });
  });

  it("compact amounts carry no cents", () => {
    expect(splitUsd(1_240_000)).toEqual({ main: "$1.24M", cents: null });
  });
});
