// WCAG contrast verification (doc 01 step 13) — parses the real token file
// (apps/web/app/globals.css), composes the four theme combinations (light,
// dark, ±cvd), and fails CI when any checked pair regresses below its
// threshold: 4.5:1 for text (captions included), 3:1 for large-text/non-text.
//
//   pnpm contrast        (node --experimental-strip-types scripts/contrast.ts)
//
// Pair classifications follow documented usage; where a spec-fixed primitive
// cannot meet 4.5:1 as small text (light gain-500, light amber, dark crimson)
// the pair is held to the 3:1 large-text/non-text bar and the note records
// the adopted DS-10.2-style fallback. Results are summarized in
// docs/prompts/HANDOFF.md (module 01 entry).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cssPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps/web/app/globals.css",
);
const css = readFileSync(cssPath, "utf8");

// --- token parsing ----------------------------------------------------------

type Vars = Record<string, string>;

/** Collects custom properties from every top-level `selector { … }` block. */
function blockVars(selector: string): Vars {
  const vars: Vars = {};
  const re = new RegExp(
    `^${selector.replace(/[.:()]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "gm",
  );
  for (const m of css.matchAll(re)) {
    for (const decl of m[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      vars[decl[1]] = decl[2].trim();
    }
  }
  return vars;
}

function resolveVars(vars: Vars): Vars {
  const out: Vars = { ...vars };
  for (const [k, v] of Object.entries(out)) {
    const ref = v.match(/^var\(--([\w-]+)\)$/);
    if (ref && out[ref[1]]) out[k] = out[ref[1]];
  }
  return out;
}

const rootVars = blockVars(":root");
const darkVars = blockVars(".dark");
const cvdVars = blockVars(".cvd");
const cvdLightVars = blockVars(".cvd:not(.dark)");
// Plain-light-only companions (doc 12) — scoped so they can't cascade over
// the later-authored .dark/.cvd blocks the way a bare :root would.
const lightOnlyVars = blockVars(":root:not(.dark):not(.cvd)");

const themes: Record<string, Vars> = {
  light: resolveVars({ ...rootVars, ...lightOnlyVars }),
  dark: resolveVars({ ...rootVars, ...darkVars }),
  "light+cvd": resolveVars({ ...rootVars, ...cvdVars, ...cvdLightVars }),
  "dark+cvd": resolveVars({ ...rootVars, ...darkVars, ...cvdVars }),
};

// --- color math (OKLCH → linear sRGB → WCAG relative luminance) -------------

function parseOklch(value: string): [number, number, number] {
  const m = value.match(
    /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/[^)]*)?\)/,
  );
  if (!m) throw new Error(`not an oklch() value: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function oklchToLinearSrgb(L: number, C: number, H: number) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v)));
}

function luminance(value: string): number {
  const [r, g, b] = oklchToLinearSrgb(...parseOklch(value));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// --- checked pairs -----------------------------------------------------------

type Check = {
  theme: keyof typeof themes & string;
  fg: string;
  bg: string;
  min: number;
  label: string;
  note?: string;
};

const TEXT = 4.5;
const LARGE = 3; // large text (≥18.66px bold / 24px) and non-text (1.4.11)

const checks: Check[] = [
  // — mandated: teal on graphite at all sizes (captions included) —
  { theme: "dark", fg: "primary", bg: "background", min: TEXT, label: "teal text on graphite-950" },
  { theme: "dark", fg: "primary", bg: "card", min: TEXT, label: "teal text on graphite-900" },
  { theme: "light", fg: "primary", bg: "background", min: TEXT, label: "teal text on paper-50 (captions incl.)" },
  { theme: "light", fg: "primary", bg: "card", min: TEXT, label: "teal text on paper-100" },

  // — mandated: muted-foreground on backgrounds —
  { theme: "dark", fg: "muted-foreground", bg: "background", min: TEXT, label: "muted text on graphite-950" },
  { theme: "dark", fg: "muted-foreground", bg: "card", min: TEXT, label: "muted text on graphite-900" },
  { theme: "light", fg: "muted-foreground", bg: "background", min: TEXT, label: "muted text on paper-50" },
  { theme: "light", fg: "muted-foreground", bg: "card", min: TEXT, label: "muted text on paper-100" },

  // — body text —
  { theme: "dark", fg: "foreground", bg: "background", min: TEXT, label: "ink on graphite-950" },
  { theme: "dark", fg: "card-foreground", bg: "card", min: TEXT, label: "ink on graphite-900" },
  { theme: "light", fg: "foreground", bg: "background", min: TEXT, label: "ink on paper-50" },
  { theme: "light", fg: "card-foreground", bg: "card", min: TEXT, label: "ink on paper-100" },

  // — deltas (gain/loss text, both surfaces) —
  { theme: "dark", fg: "positive", bg: "background", min: TEXT, label: "gain text on graphite-950" },
  { theme: "dark", fg: "positive", bg: "card", min: TEXT, label: "gain text on graphite-900" },
  { theme: "dark", fg: "negative", bg: "background", min: TEXT, label: "loss text on graphite-950" },
  { theme: "dark", fg: "negative", bg: "card", min: TEXT, label: "loss text on graphite-900" },
  // module 12 closed module 01's open question: the companion light --positive
  // (0.52) restores full-text contrast at every size, so the LARGE-only
  // fallback is retired and delta text is token-colored app-wide.
  { theme: "light", fg: "positive", bg: "background", min: TEXT, label: "gain text on paper-50" },
  { theme: "light", fg: "positive", bg: "card", min: TEXT, label: "gain text on paper-100" },
  { theme: "light", fg: "negative", bg: "background", min: TEXT, label: "loss text on paper-50" },

  // — CVD pair (independent of mode — DS-2.2) —
  { theme: "dark+cvd", fg: "positive", bg: "background", min: TEXT, label: "CVD gain (blue) on graphite-950" },
  { theme: "dark+cvd", fg: "negative", bg: "background", min: TEXT, label: "CVD loss (orange) on graphite-950" },
  { theme: "dark+cvd", fg: "positive", bg: "card", min: TEXT, label: "CVD gain (blue) on graphite-900" },
  { theme: "dark+cvd", fg: "negative", bg: "card", min: TEXT, label: "CVD loss (orange) on graphite-900" },
  { theme: "light+cvd", fg: "positive", bg: "background", min: TEXT, label: "CVD gain (blue) on paper-50" },
  { theme: "light+cvd", fg: "negative", bg: "background", min: TEXT, label: "CVD loss (orange) on paper-50" },
  { theme: "light+cvd", fg: "positive", bg: "card", min: TEXT, label: "CVD gain (blue) on paper-100" },
  { theme: "light+cvd", fg: "negative", bg: "card", min: TEXT, label: "CVD loss (orange) on paper-100" },

  // — status colors —
  {
    theme: "dark", fg: "warning", bg: "background", min: TEXT,
    label: "amber text on graphite-950",
  },
  {
    theme: "light", fg: "warning", bg: "background", min: LARGE,
    label: "amber on paper-50 (non-text only)",
    note: "3.03 — amber in light theme is icons/fills only; warning text renders warning-foreground on a warning fill (5.48)",
  },
  { theme: "dark", fg: "warning-foreground", bg: "warning", min: TEXT, label: "text on amber banner (dark)" },
  { theme: "light", fg: "warning-foreground", bg: "warning", min: TEXT, label: "text on amber banner (light)" },
  {
    theme: "dark", fg: "destructive", bg: "background", min: LARGE,
    label: "crimson on graphite-950 (non-text only)",
    note: "3.61 — crimson is fills + the kill-switch surface, never body text on graphite; buttons pair destructive-foreground on a crimson fill (5.08)",
  },
  { theme: "light", fg: "destructive", bg: "background", min: TEXT, label: "crimson text on paper-50" },
  { theme: "dark", fg: "destructive-foreground", bg: "destructive", min: TEXT, label: "text on crimson button (dark)" },
  { theme: "light", fg: "destructive-foreground", bg: "destructive", min: TEXT, label: "text on crimson button (light)" },

  // — component fills —
  { theme: "dark", fg: "primary-foreground", bg: "primary", min: TEXT, label: "text on teal button (dark)" },
  { theme: "light", fg: "primary-foreground", bg: "primary", min: TEXT, label: "text on teal button (light)" },
  { theme: "dark", fg: "positive-foreground", bg: "positive", min: TEXT, label: "text on gain fill (dark)" },
  { theme: "dark", fg: "negative-foreground", bg: "negative", min: TEXT, label: "text on loss fill (dark)" },
  { theme: "light", fg: "positive-foreground", bg: "positive", min: TEXT, label: "text on gain fill (light)" },
  { theme: "light", fg: "negative-foreground", bg: "negative", min: TEXT, label: "text on loss fill (light)" },

  // — focus indicator (WCAG 2.4.11: ≥3:1 against adjacent surfaces) —
  { theme: "dark", fg: "ring", bg: "background", min: LARGE, label: "focus ring on graphite-950" },
  { theme: "dark", fg: "ring", bg: "card", min: LARGE, label: "focus ring on graphite-900" },
  { theme: "light", fg: "ring", bg: "background", min: LARGE, label: "focus ring on paper-50" },
  { theme: "light", fg: "ring", bg: "card", min: LARGE, label: "focus ring on paper-100" },

  // — C9 allocation ring ramp (doc 12): DS-10.2 non-text ≥3:1 between every
  //   ADJACENT segment. Segments take tokens 1..n largest-first, so the
  //   binding pairs are the consecutive ones plus every wrap back to 1
  //   (@retenix/shared REQUIRED_ALLOC_PAIRS mirrors this list). —
  ...(
    [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [1, 3],
      [1, 4],
      [1, 5],
    ] as const
  ).flatMap(([a, b]) =>
    (["light", "dark"] as const).map(
      (theme): Check => ({
        theme,
        fg: `alloc-${a}`,
        bg: `alloc-${b}`,
        min: LARGE,
        label: `allocation ramp ${a}↔${b} (adjacent segments)`,
      }),
    ),
  ),
];

// --- run ----------------------------------------------------------------------

let failed = 0;
console.log("WCAG contrast — apps/web/app/globals.css\n");
for (const c of checks) {
  const vars = themes[c.theme];
  const fg = vars[c.fg];
  const bg = vars[c.bg];
  if (!fg || !bg) {
    console.error(`✗ ${c.theme}: missing token --${!fg ? c.fg : c.bg}`);
    failed++;
    continue;
  }
  const r = ratio(fg, bg);
  const ok = r >= c.min;
  if (!ok) failed++;
  const line = `${ok ? "✓" : "✗"} ${r.toFixed(2).padStart(6)}  (min ${c.min})  [${c.theme}] ${c.label}`;
  console.log(line);
  if (!ok && c.note) console.log(`    note: ${c.note}`);
}

console.log(
  failed === 0
    ? `\nall ${checks.length} pairs pass`
    : `\n${failed} of ${checks.length} pairs FAIL`,
);
process.exit(failed === 0 ? 0 : 1);
