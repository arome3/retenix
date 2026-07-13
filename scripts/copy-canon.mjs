// Copy-canon CI grep (doc 01 / G12) — banned vocabulary in decision surfaces
// is a RELEASE BLOCKER (breaks PS-F1-AC3 and the trust posture), not a nit.
//
//   pnpm copy-canon
//
// Scans user-facing copy in apps/web — string literals and JSX text, not code
// identifiers (chainId, networkFee are code; "across 5 chains" is copy) and not
// comments (dev-facing prose that never reaches a user — masked before scan).
//
// Banned (G12): gas · bridge · chain · network (as a choice) · seed phrase ·
// wallet / wallet address · slippage · sign transaction · smart contract ·
// delegate.
//
// Allowlisted (CONFLICTS.md #15):
//  - trust-proof phrases, verbatim: "enforced on-chain",
//    "enforced by the chain, not by us"
//  - receipt contexts (receipts may name networks — required transparency):
//    add `copy-canon-allow` in a comment on the same line

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["app", "components", "lib", "hooks", "server"].map((d) =>
  join(root, "apps/web", d),
);

const BANNED = [
  { word: "gas", re: /\bgas\b/i },
  { word: "bridge", re: /\bbridg(?:e|es|ed|ing)\b/i },
  { word: "chain", re: /\bchains?\b/i },
  { word: "network", re: /\bnetworks?\b/i },
  { word: "seed phrase", re: /\bseed[\s-]?phrases?\b/i },
  { word: "wallet", re: /\bwallets?\b/i },
  { word: "slippage", re: /\bslippage\b/i },
  { word: "sign transaction", re: /\bsign(?:ing)?[\s-]transactions?\b/i },
  { word: "smart contract", re: /\bsmart[\s-]contracts?\b/i },
  { word: "delegate", re: /\bdelegat(?:e|es|ed|ing|ion|ions)\b/i },
];

const ALLOWED_PHRASES = [
  /enforced on-chain/gi,
  /enforced by the chain, not by us/gi,
];

const ALLOW_MARKER = "copy-canon-allow";

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // scan dir not created yet
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      yield* walk(p);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\./.test(name)) {
      yield p;
    }
  }
}

/** User-copy segments: string literals ('…' "…" `…`) and JSX text nodes. */
function segments(source) {
  const out = [];
  const stringRe =
    /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  for (const m of source.matchAll(stringRe)) {
    out.push({ text: m[0].slice(1, -1), index: m.index });
  }
  // JSX text: prose runs delimited by tags (>…<) or expression braces
  // (}…{ etc.) — a heuristic that catches copy without a full parse
  for (const m of source.matchAll(/[>}]([^<>{}`]+)[<{]/g)) {
    out.push({ text: m[1], index: m.index + 1 });
  }
  return out;
}

/** Module specifiers and class strings aren't copy: whitespace-free tokens. */
function looksLikeCode(text) {
  return !/\s/.test(text.trim()) && /[/@_.:-]/.test(text);
}

/**
 * Blank out `//` and block comments so the copy heuristics never read
 * developer prose as JSX text (a stray `}` in an import and a `{` in a comment
 * would otherwise bracket a comment as one "segment"). Comment bodies become
 * spaces — byte offsets and newlines are preserved, so line numbers still line
 * up with the original source. String / template literals are copied verbatim:
 * they're exactly what we DO want to scan, and a `//` or `/*` inside one must
 * not be mistaken for a comment.
 */
function maskComments(src) {
  let out = "";
  const n = src.length;
  for (let i = 0; i < n; ) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < n) {
        const d = src[i];
        out += d;
        i++;
        if (d === "\\") {
          if (i < n) out += src[i++];
          continue;
        }
        if (d === c) break;
        if (c !== "`" && d === "\n") break; // unterminated ' or " — bail
      }
      continue;
    }
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2; // consume the closing */
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const violations = [];

for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    const source = readFileSync(file, "utf8");
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source[i] === "\n") lineStarts.push(i + 1);
    }
    const lineOf = (index) => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= index) lo = mid;
        else hi = mid - 1;
      }
      return lo; // 0-based
    };
    const lines = source.split("\n");
    // Mask comments so their prose can't be read as user copy; offsets and
    // line numbers are preserved, so `lineOf` / `lines` still index correctly.
    const scannable = maskComments(source);

    for (const seg of segments(scannable)) {
      if (looksLikeCode(seg.text)) continue;
      const line = lineOf(seg.index);
      if (lines[line]?.includes(ALLOW_MARKER)) continue;
      let text = seg.text;
      for (const allowed of ALLOWED_PHRASES) text = text.replace(allowed, "");
      for (const { word, re } of BANNED) {
        if (re.test(text)) {
          violations.push({
            file: relative(root, file),
            line: line + 1,
            word,
            excerpt: seg.text.trim().slice(0, 80),
          });
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `copy-canon: ${violations.length} banned-vocabulary violation(s) — release blocker (G12 / PS-F1-AC3)\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.word}]  “${v.excerpt}”`);
  }
  console.error(
    "\nReplacements: fees (one number) · sources (receipts only) · confirm · account.",
  );
  console.error(
    "Receipt contexts may name networks — mark the line with `copy-canon-allow`.",
  );
  process.exit(1);
}

console.log("copy-canon: clean — no banned vocabulary in apps/web user copy");
