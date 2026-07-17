// Canonical copy formats, project-wide (doc 01 §Content & formatting rules;
// CONFLICTS.md #9). Intl.NumberFormat for all locale formatting — no
// hand-rolled strings. The directional glyphs ▲ ▼ + − are text, never icons
// (DS-5.2), so they inherit tabular alignment; the minus is U+2212.
//
// Render every mutable number through <Num> (components/Num.tsx) so it picks
// up `.tnum` — G13 applies to balances, deltas, fees, tables, countdowns.

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumSignificantDigits: 3,
});

/** USD, always two decimals ("display the zeros"); ≥$100K abbreviates to
 *  3 significant digits — `$1.24M`. */
export const fmtUsd = (v: number) =>
  (Math.abs(v) >= 100_000 ? usdCompact : usd).format(v);

/** Percentages to hundredths: `2.15%`. Sign is the caller's job (fmtDelta). */
export const fmtPct = (v: number) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v) + "%";

/** Deltas always signed + glyphed: `▲ +$12.40 (+2.15%)` / `▼ −$3.20 (−0.85%)`.
 *  Color is never the sole encoder (WCAG 1.4.1) — the sign and glyph are the
 *  guaranteed channel. */
export const fmtDelta = (usdV: number, pctV: number) =>
  `${usdV >= 0 ? "▲ +" : "▼ −"}${fmtUsd(Math.abs(usdV)).replace("$", "$")} (${usdV >= 0 ? "+" : "−"}${fmtPct(Math.abs(pctV))})`;

/** Addresses: first 6 / last 4, `0x1234…abcd`. Geist Mono, copy-full
 *  affordance; receipts & settings only — never decision surfaces. */
export const truncAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const timeFmt = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});
const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const absFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const MIN = 60_000;
const DAY = 86_400_000;

/** "just now" <1m → "3:12 PM" <1d → "Yesterday at 3:12 PM" → "12d ago" <30d →
 *  absolute "Jun 4, 2026" after. Tooltips ALWAYS show absTime(d). */
export function relTime(d: Date, now = new Date()): string {
  const ms = now.getTime() - d.getTime();
  if (ms < MIN) return "just now"; // includes clock skew into the future
  if (ms < DAY) return timeFmt.format(d);
  if (ms < 2 * DAY) return `Yesterday at ${timeFmt.format(d)}`;
  if (ms < 30 * DAY) return `${Math.floor(ms / DAY)}d ago`;
  return dateFmt.format(d);
}

/** The tooltip/`title` companion to relTime — "Jun 4, 2026, 3:12 PM". */
export const absTime = (d: Date) => absFmt.format(d);

/** Buying-power hero split (§3): dollars full-size, cents at 60% superscript-
 *  aligned (doc 06 consumes via <HeroMoney>). Compact amounts (≥$100K) carry
 *  no cents. */
export function splitUsd(v: number): { main: string; cents: string | null } {
  if (Math.abs(v) >= 100_000) return { main: usdCompact.format(v), cents: null };
  const s = usd.format(v);
  const dot = s.lastIndexOf(".");
  return { main: s.slice(0, dot), cents: s.slice(dot + 1) };
}

/** C8 countdown remaining time — "4d 12h" / "2h 05m" / "1m 30s" / "42s".
 *  Digits change every second at demo scale, so the caller renders it through
 *  <Num> (.tnum — G13). Clamped at zero (an elapsed countdown never renders
 *  negative time). */
export function formatCountdown(msRemaining: number): string {
  const s = Math.max(0, Math.floor(msRemaining / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}
