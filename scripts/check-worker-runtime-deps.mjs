// Worker runtime-resolution guard (doc 17 §Topology — the packaging half).
//
// WHY THIS EXISTS. The worker ships on tsx, not a bundle: packages/* export TS
// source (`main` → src/index.ts), so a `tsc` dist would emit `import "@retenix/db"`
// pointing at TypeScript, and a bundler that externalises the leaves emits
// `import "pg"` / `import "@particle-network/…"` from apps/worker/dist/, which
// Node cannot resolve — pnpm links `pg` under packages/db and the UA SDK under
// packages/ua, neither of which is reachable from apps/worker. tsx never moves a
// file, so every import resolves from its own package exactly as it does in dev.
//
// The cost of that choice is one new failure class: a bare specifier added to
// apps/worker/src that is NOT in apps/worker/package.json typechecks fine (types
// hoist) and dies at runtime. This walks the worker's real import graph and
// proves every bare specifier resolves from the file that imports it. It is the
// second half of `pnpm --filter worker build`.
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = ["apps/worker/src/index.ts", "apps/worker/env.ts"];
const rel = (f) => f.slice(ROOT.length + 1);

const BUILTINS = new Set(builtinModules);
const isBuiltin = (s) => s.startsWith("node:") || BUILTINS.has(s);
const isRelative = (s) => s.startsWith("./") || s.startsWith("../");

// Value imports/re-exports only — `import type` erases before runtime. The
// clause may span lines, so the body match excludes `;` and quotes rather than
// newlines. Side-effect and dynamic imports are matched separately.
const FROM_RE =
  /^[ \t]*(?:import|export)[ \t]+(?!type[ \t])(?:[^;'"]|'[^']*'|"[^"]*")*?from[ \t]*["']([^"']+)["']/gm;
const SIDE_EFFECT_RE = /^[ \t]*import[ \t]*["']([^"']+)["']/gm;
const DYNAMIC_RE = /\bimport[ \t]*\([ \t]*["']([^"']+)["'][ \t]*\)/g;

/** Every specifier a file pulls in at runtime. */
function specifiers(source) {
  const out = new Set();
  for (const re of [FROM_RE, SIDE_EFFECT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) out.add(m[1]);
  }
  return out;
}

/** `@scope/name/sub` → `@scope/name`; `pkg/sub` → `pkg`. */
function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * The workspace package that owns a file, with its manifest.
 *
 * Deliberately NOT "does node_modules/<pkg> exist somewhere up the tree": the
 * repo root carries devDependencies (`pg`, `jose` — module 02 added them for
 * e2e) that a production install prunes, so mere reachability on THIS machine
 * proves nothing about Railway. Declared ownership does.
 */
function owningPackage(file) {
  let dir = dirname(file);
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      return { dir, json: JSON.parse(readFileSync(manifest, "utf8")) };
    }
    const parent = dirname(dir);
    if (parent === dir || dir === ROOT) return null;
    dir = parent;
  }
}

/** Runtime deps only — devDependencies do not survive a production install. */
function declares(pkgJson, name) {
  return Boolean(
    pkgJson.dependencies?.[name] ??
      pkgJson.peerDependencies?.[name] ??
      pkgJson.optionalDependencies?.[name],
  );
}

/** Relative/workspace specifier → the .ts file it means, or null if external. */
function resolveSourceFile(specifier, fromFile) {
  let base;
  if (isRelative(specifier)) {
    base = resolve(dirname(fromFile), specifier);
  } else if (specifier.startsWith("@retenix/")) {
    // Workspace packages export TS source; honour their package.json entry so
    // subpath exports (@retenix/shared/escrow) are followed too, not guessed.
    const pkgDir = join(ROOT, "packages", packageName(specifier).slice("@retenix/".length));
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) return null;
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    const subpath = specifier.slice(packageName(specifier).length);
    const entry = subpath
      ? pkgJson.exports?.[`.${subpath}`]
      : (pkgJson.exports?.["."] ?? pkgJson.main);
    if (typeof entry !== "string") return null;
    base = resolve(pkgDir, entry);
  } else {
    return null; // external package — checked by resolvesFrom, not walked
  }

  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const seen = new Set();
const errors = [];
const queue = ENTRIES.map((e) => join(ROOT, e));

while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);

  const source = readFileSync(file, "utf8");
  for (const specifier of specifiers(source)) {
    if (isBuiltin(specifier)) continue;

    const next = resolveSourceFile(specifier, file);
    if (next) {
      queue.push(next);
      continue;
    }
    if (isRelative(specifier)) {
      errors.push(`${file}: cannot resolve relative import "${specifier}"`);
      continue;
    }
    // External package: the package that OWNS this file must declare it as a
    // runtime dependency. tsx loads the file in place, so Node resolves from
    // here — and a production install keeps only what this manifest declares.
    const pkg = packageName(specifier);
    const owner = owningPackage(file);
    if (!owner) {
      errors.push(`${rel(file)}: no owning package.json found`);
    } else if (!declares(owner.json, pkg)) {
      errors.push(
        `${rel(file)}: imports "${specifier}" but ${owner.json.name} does not declare ` +
          `"${pkg}" in dependencies — it resolves locally via a hoisted or dev-only copy ` +
          `and will crash once a production install prunes it`,
      );
    }
  }
}

if (errors.length) {
  console.error("worker runtime deps: FAILED");
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`worker runtime deps ok (${seen.size} modules walked)`);
