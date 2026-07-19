// NYSE trading calendar (doc 19, G-H2) — pure, table-driven, zero deps.
//
// WHY THIS EXISTS: equity perps are NOT 24/7. Ostium documents Mon–Fri
// 9:30–16:00 ET and rejects market orders off-hours; gTrade documents
// 9:35–16:00 and additionally blocks CLOSING and EDITING outside the session.
// So the calendar is per-venue, not global, and "can I open?" and "can I
// close?" are different questions.
//
// ET wall-clock comes from Intl.DateTimeFormat with timeZone
// "America/New_York" — DST-correct without a tz dependency or a new pin.
// The UTC offset can only change on a Sunday (US DST transitions), when the
// market is shut, so it is constant across any single trading session.
//
// ⚠ THE HOLIDAY TABLE HAS A HORIZON. `NYSE_VALID_THROUGH_YEAR` is a hard stop:
// past it, every function THROWS rather than returning "open". A silently
// empty holiday list reads as "the market is always open", which would market-
// order into a closed venue on Christmas Day. Extend the table deliberately.

/** Venues differ on the opening minute; both close at 16:00 ET. */
export type VenueCalendar = "nyse" | "nyse-gtrade" | "24-7";

export type MarketState =
  | "open"
  | "closed-weekend"
  | "closed-holiday"
  | "closed-pre-open"
  | "closed-post-close";

export interface MarketHoursState {
  state: MarketState;
  isOpen: boolean;
  /** Early-close day (13:00 ET) — receipts may name it. */
  isHalfDay: boolean;
  /** Session bounds in epoch ms; null when the day has no session at all. */
  sessionOpenMs: number | null;
  sessionCloseMs: number | null;
  /** Next session open in epoch ms — feeds retryAfter and limit-order goodTil. */
  nextOpenMs: number;
}

/** The last year `NYSE_HOLIDAYS`/`NYSE_HALF_DAYS` actually cover. */
export const NYSE_VALID_THROUGH_YEAR = 2026;

/**
 * Full closures, `YYYY-MM-DD` in ET. Verified against the observance rules
 * (Sat → observed Friday, Sun → observed Monday) rather than transcribed.
 *
 * ⚠ 2026 gotcha: July 4 falls on a SATURDAY, so Friday July 3 is the observed
 * holiday and a FULL closure — it is NOT the usual July-3 half day. Hand-built
 * tables get this backwards every leap of the calendar.
 */
export const NYSE_HOLIDAYS: readonly string[] = [
  "2026-01-01", // New Year's Day (Thu)
  "2026-01-19", // MLK Day (3rd Mon Jan)
  "2026-02-16", // Presidents' Day (3rd Mon Feb)
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day (last Mon May)
  "2026-06-19", // Juneteenth (Fri)
  "2026-07-03", // Independence Day OBSERVED (Jul 4 is a Saturday)
  "2026-09-07", // Labor Day (1st Mon Sep)
  "2026-11-26", // Thanksgiving (4th Thu Nov)
  "2026-12-25", // Christmas (Fri)
];

/** Early closes at 13:00 ET. */
export const NYSE_HALF_DAYS: readonly string[] = [
  "2026-11-27", // day after Thanksgiving
  "2026-12-24", // Christmas Eve (Dec 25 is a weekday, so this is an early close)
];

const HOLIDAYS = new Set(NYSE_HOLIDAYS);
const HALF_DAYS = new Set(NYSE_HALF_DAYS);

const OPEN_MINUTES: Record<Exclude<VenueCalendar, "24-7">, number> = {
  nyse: 9 * 60 + 30, // Ostium and the exchange itself
  "nyse-gtrade": 9 * 60 + 35, // gTrade documents a 9:35 open
};
const CLOSE_MINUTE = 16 * 60;
const HALF_DAY_CLOSE_MINUTE = 13 * 60;

const ET = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

interface EtParts {
  year: number;
  month: number;
  day: number;
  minutes: number; // minutes since ET midnight
  ymd: string;
  /** 0 = Sunday. */
  weekday: number;
}

function etPartsOf(atMs: number): EtParts {
  const p: Record<string, string> = {};
  for (const part of ET.formatToParts(new Date(atMs))) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  const ymd = `${p.year}-${p.month}-${p.day}`;
  // Weekday from the ET calendar date, not the UTC one — near midnight they
  // differ, and "is it a weekend" must follow the exchange's own date.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, minutes, ymd, weekday };
}

/** ET offset from UTC at this instant, in ms (negative: ET is behind UTC). */
function etOffsetMs(atMs: number): number {
  const p = etPartsOf(atMs);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, 0, 0) + p.minutes * 60_000;
  // Round to the minute: formatToParts drops seconds, so the raw difference
  // carries the instant's sub-minute remainder.
  return asIfUtc - Math.floor(atMs / 60_000) * 60_000;
}

/** Epoch ms for an ET wall-clock minute on the ET date containing `atMs`. */
function etMinuteToMs(atMs: number, minuteOfDay: number): number {
  const p = etPartsOf(atMs);
  const naive = Date.UTC(p.year, p.month - 1, p.day, 0, 0) + minuteOfDay * 60_000;
  return naive - etOffsetMs(atMs);
}

function assertInHorizon(year: number): void {
  if (year > NYSE_VALID_THROUGH_YEAR) {
    throw new Error(
      `NYSE calendar covers through ${NYSE_VALID_THROUGH_YEAR}; asked about ${year}. ` +
        `Extend NYSE_HOLIDAYS/NYSE_HALF_DAYS — an empty table would read as "always open".`,
    );
  }
}

function isSessionDay(p: EtParts): boolean {
  if (p.weekday === 0 || p.weekday === 6) return false;
  return !HOLIDAYS.has(p.ymd);
}

/** The always-open branch — crypto pairs (doc 19:20). */
export function alwaysOpen(atMs: number): MarketHoursState {
  return {
    state: "open",
    isOpen: true,
    isHalfDay: false,
    sessionOpenMs: null,
    sessionCloseMs: null,
    nextOpenMs: atMs,
  };
}

export function nyseStateAt(
  atMs: number,
  calendar: Exclude<VenueCalendar, "24-7"> = "nyse",
): MarketHoursState {
  const p = etPartsOf(atMs);
  assertInHorizon(p.year);

  const openMinute = OPEN_MINUTES[calendar];
  const sessionDay = isSessionDay(p);
  const isHalfDay = sessionDay && HALF_DAYS.has(p.ymd);
  const closeMinute = isHalfDay ? HALF_DAY_CLOSE_MINUTE : CLOSE_MINUTE;

  const sessionOpenMs = sessionDay ? etMinuteToMs(atMs, openMinute) : null;
  const sessionCloseMs = sessionDay ? etMinuteToMs(atMs, closeMinute) : null;

  let state: MarketState;
  if (!sessionDay) {
    state = p.weekday === 0 || p.weekday === 6 ? "closed-weekend" : "closed-holiday";
  } else if (p.minutes < openMinute) {
    state = "closed-pre-open";
  } else if (p.minutes >= closeMinute) {
    state = "closed-post-close";
  } else {
    state = "open";
  }

  const isOpen = state === "open";
  return {
    state,
    isOpen,
    isHalfDay,
    sessionOpenMs,
    sessionCloseMs,
    nextOpenMs: isOpen ? atMs : nextNyseOpen(atMs, calendar),
  };
}

export function isNyseOpen(
  atMs: number,
  calendar: Exclude<VenueCalendar, "24-7"> = "nyse",
): boolean {
  return nyseStateAt(atMs, calendar).isOpen;
}

/**
 * Next session open at or after `atMs`. Walks forward a bounded number of ET
 * days — a holiday weekend is at most 4 consecutive closures, so 10 is ample
 * slack, and the bound means a table gap can never spin forever.
 */
export function nextNyseOpen(
  atMs: number,
  calendar: Exclude<VenueCalendar, "24-7"> = "nyse",
): number {
  const openMinute = OPEN_MINUTES[calendar];
  let cursor = atMs;
  for (let i = 0; i < 10; i++) {
    const p = etPartsOf(cursor);
    assertInHorizon(p.year);
    if (isSessionDay(p)) {
      const open = etMinuteToMs(cursor, openMinute);
      if (open > atMs) return open;
    }
    // Step to ~noon ET tomorrow: noon is far from every DST boundary and from
    // midnight, so the ET calendar date advances by exactly one regardless.
    cursor = etMinuteToMs(cursor, 12 * 60) + 24 * 60 * 60_000;
  }
  throw new Error(
    `no NYSE session found within 10 days of ${new Date(atMs).toISOString()} — holiday table gap?`,
  );
}

/** Which calendar an asset follows (doc 19: crypto pairs are 24/7). */
export function calendarFor(
  assetKind: "equity" | "crypto" | "rwa-gold" | "leveraged",
): VenueCalendar {
  return assetKind === "crypto" ? "24-7" : "nyse";
}
