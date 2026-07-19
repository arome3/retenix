import { describe, expect, it } from "vitest";
import {
  alwaysOpen,
  calendarFor,
  isNyseOpen,
  nextNyseOpen,
  NYSE_HALF_DAYS,
  NYSE_HOLIDAYS,
  NYSE_VALID_THROUGH_YEAR,
  nyseStateAt,
} from "./market-hours";

/** An ET wall-clock moment as epoch ms, via the offset the runtime reports. */
function et(ymd: string, hhmm: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const [hh, mi] = hhmm.split(":").map(Number);
  // Probe the offset on that date at noon UTC, then correct.
  const probe = Date.UTC(y, m - 1, d, 12, 0);
  const shown = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(probe));
  const etHour = Number(shown.find((p) => p.type === "hour")?.value);
  const offsetHours = 12 - etHour; // hours ET is behind UTC
  return Date.UTC(y, m - 1, d, hh + offsetHours, mi);
}

describe("NYSE session boundaries", () => {
  // 2026-07-15 is a Wednesday, an ordinary full session.
  it("is open through a regular session and closed on its edges", () => {
    expect(isNyseOpen(et("2026-07-15", "09:29"))).toBe(false);
    expect(isNyseOpen(et("2026-07-15", "09:30"))).toBe(true);
    expect(isNyseOpen(et("2026-07-15", "12:00"))).toBe(true);
    expect(isNyseOpen(et("2026-07-15", "15:59"))).toBe(true);
    // 16:00 is the close, not the last open minute.
    expect(isNyseOpen(et("2026-07-15", "16:00"))).toBe(false);
  });

  it("reports the state, not just a boolean", () => {
    expect(nyseStateAt(et("2026-07-15", "08:00")).state).toBe("closed-pre-open");
    expect(nyseStateAt(et("2026-07-15", "12:00")).state).toBe("open");
    expect(nyseStateAt(et("2026-07-15", "17:00")).state).toBe("closed-post-close");
  });

  it("gTrade opens five minutes later than the exchange (per-venue, not global)", () => {
    const at = et("2026-07-15", "09:32");
    expect(isNyseOpen(at, "nyse")).toBe(true);
    expect(isNyseOpen(at, "nyse-gtrade")).toBe(false);
    expect(nyseStateAt(at, "nyse-gtrade").state).toBe("closed-pre-open");
  });
});

describe("weekends and holidays", () => {
  it("is closed all weekend", () => {
    expect(nyseStateAt(et("2026-07-18", "12:00")).state).toBe("closed-weekend"); // Sat
    expect(nyseStateAt(et("2026-07-19", "12:00")).state).toBe("closed-weekend"); // Sun
  });

  it.each(NYSE_HOLIDAYS)("is closed all day on %s", (ymd) => {
    const s = nyseStateAt(et(ymd, "12:00"));
    expect(s.isOpen).toBe(false);
    expect(s.sessionOpenMs).toBeNull();
    expect(s.sessionCloseMs).toBeNull();
  });

  it("labels a weekday holiday 'closed-holiday', never 'closed-weekend'", () => {
    expect(nyseStateAt(et("2026-12-25", "12:00")).state).toBe("closed-holiday"); // Friday
  });

  it("JULY 3 2026 IS A FULL CLOSURE, NOT A HALF DAY (Jul 4 is a Saturday)", () => {
    // The classic hand-built-table bug: July 3 is usually an early close, but
    // in 2026 it IS the observed Independence Day.
    const s = nyseStateAt(et("2026-07-03", "12:00"));
    expect(s.state).toBe("closed-holiday");
    expect(s.isHalfDay).toBe(false);
    expect(s.isOpen).toBe(false);
    expect(NYSE_HALF_DAYS).not.toContain("2026-07-03");
  });
});

describe("half days close at 13:00 ET", () => {
  it.each(NYSE_HALF_DAYS)("%s trades until 13:00 and not after", (ymd) => {
    expect(isNyseOpen(et(ymd, "12:59"))).toBe(true);
    expect(isNyseOpen(et(ymd, "13:00"))).toBe(false);
    expect(isNyseOpen(et(ymd, "15:00"))).toBe(false);
    expect(nyseStateAt(et(ymd, "12:00")).isHalfDay).toBe(true);
  });

  it("a full session is NOT flagged as a half day", () => {
    expect(nyseStateAt(et("2026-07-15", "12:00")).isHalfDay).toBe(false);
    expect(isNyseOpen(et("2026-07-15", "15:00"))).toBe(true);
  });
});

describe("DST correctness (the reason this uses Intl, not a fixed offset)", () => {
  it("holds the session open across the spring-forward boundary", () => {
    // 2026-03-08 is the DST switch (a Sunday). Fri before / Mon after.
    expect(isNyseOpen(et("2026-03-06", "10:00"))).toBe(true);
    expect(isNyseOpen(et("2026-03-09", "10:00"))).toBe(true);
    expect(isNyseOpen(et("2026-03-06", "09:00"))).toBe(false);
    expect(isNyseOpen(et("2026-03-09", "09:00"))).toBe(false);
  });

  it("holds the session open across the fall-back boundary", () => {
    // 2026-11-01 is the switch (a Sunday).
    expect(isNyseOpen(et("2026-10-30", "10:00"))).toBe(true);
    expect(isNyseOpen(et("2026-11-02", "10:00"))).toBe(true);
  });

  it("the UTC hour of the open differs either side of the switch", () => {
    // EST = UTC-5, EDT = UTC-4 — if this ever matches, the offset is hardcoded.
    const winter = new Date(nyseStateAt(et("2026-01-05", "12:00")).sessionOpenMs!);
    const summer = new Date(nyseStateAt(et("2026-07-15", "12:00")).sessionOpenMs!);
    expect(winter.getUTCHours()).toBe(14); // 09:30 EST
    expect(summer.getUTCHours()).toBe(13); // 09:30 EDT
  });
});

describe("nextNyseOpen", () => {
  it("returns the same day's open when asked before the bell", () => {
    const next = nextNyseOpen(et("2026-07-15", "06:00"));
    expect(next).toBe(et("2026-07-15", "09:30"));
  });

  it("rolls to the next day after the close", () => {
    expect(nextNyseOpen(et("2026-07-15", "17:00"))).toBe(et("2026-07-16", "09:30"));
  });

  it("skips the whole weekend from a Friday evening", () => {
    expect(nextNyseOpen(et("2026-07-17", "17:00"))).toBe(et("2026-07-20", "09:30"));
  });

  it("skips a holiday weekend (Thanksgiving Thu -> the Friday half day)", () => {
    // Nov 26 is Thanksgiving (closed); Nov 27 is a half day but still OPENS.
    expect(nextNyseOpen(et("2026-11-25", "17:00"))).toBe(et("2026-11-27", "09:30"));
  });

  it("skips the 4-day Christmas stretch (Fri holiday + weekend)", () => {
    // Dec 24 half day -> Dec 25 Christmas -> Sat/Sun -> Mon Dec 28.
    expect(nextNyseOpen(et("2026-12-24", "14:00"))).toBe(et("2026-12-28", "09:30"));
  });

  it("respects the venue's opening minute", () => {
    expect(nextNyseOpen(et("2026-07-15", "17:00"), "nyse-gtrade")).toBe(
      et("2026-07-16", "09:35"),
    );
  });

  it("an open market's nextOpenMs is now, so retryAfter is never negative", () => {
    const at = et("2026-07-15", "12:00");
    expect(nyseStateAt(at).nextOpenMs).toBe(at);
  });
});

describe("the horizon is a hard stop, never a silent 'always open'", () => {
  it("throws past the table's last covered year", () => {
    const past = Date.UTC(NYSE_VALID_THROUGH_YEAR + 1, 5, 15, 15, 0);
    expect(() => nyseStateAt(past)).toThrow(/calendar covers through/);
    expect(() => isNyseOpen(past)).toThrow(/calendar covers through/);
    expect(() => nextNyseOpen(past)).toThrow(/calendar covers through/);
  });

  it("the error names the fix rather than just failing", () => {
    const past = Date.UTC(NYSE_VALID_THROUGH_YEAR + 1, 0, 5, 15, 0);
    expect(() => nyseStateAt(past)).toThrow(/NYSE_HOLIDAYS/);
  });
});

describe("calendarFor", () => {
  it("sends crypto to the 24/7 branch and everything else to NYSE", () => {
    expect(calendarFor("crypto")).toBe("24-7");
    expect(calendarFor("equity")).toBe("nyse");
    expect(calendarFor("leveraged")).toBe("nyse");
    expect(calendarFor("rwa-gold")).toBe("nyse");
  });

  it("alwaysOpen is open at every instant, including Christmas", () => {
    const s = alwaysOpen(et("2026-12-25", "03:00"));
    expect(s.isOpen).toBe(true);
    expect(s.state).toBe("open");
  });
});
