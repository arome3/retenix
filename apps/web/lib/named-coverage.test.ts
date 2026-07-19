import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PS-8.2 coverage drift guard (doc 17).
 *
 * The "≥60% of sessions with zero chain-name exposure" metric is only as
 * honest as its instrumentation is complete. A component added six months from
 * now that renders a source's proper name and forgets useNamedSource does not
 * fail anything — it just quietly makes the number look better than reality.
 * That is the exact failure this metric exists to detect, so it gets a test.
 *
 * The theme.test.ts idiom: read the source, assert two things that must agree
 * still agree.
 */

const WEB = path.resolve(__dirname, "..");
const ROOTS = ["components", "app"];

/**
 * Deliberate exclusions, each a decision rather than an oversight.
 */
const ALLOWLIST: Record<string, string> = {
  "components/claim/ClaimFlow.tsx":
    "the HEIR's session — a different actor, reached pre-session by claim token. " +
    "PS-8.2 measures the owner's sessions, and instrumenting this would put " +
    "unauthenticated rows in events and force the telemetry route public.",
};

/**
 * Signals that a file puts a source's proper name in front of a user.
 *
 * The last pattern was added because the allowlist self-check below caught the
 * detector being incomplete: several components never call networkName at all,
 * they render a `network` field the SERVER already shaped (routers/portfolio,
 * lib/kill, lib/delegations all do this). Matching only the naming primitive
 * would have let that whole class through unnoticed.
 */
const RENDERS_A_SOURCE_NAME = [
  /\bnetworkName\s*\(/, // the naming primitive itself
  /\bnamesAKnownSource\s*\(/, // the sentence-level detector
  /detail\??\.sources/, // receipt expansion's named sources
  /\{[\w.]*\.network\}/, // a server-shaped name rendered straight into JSX
];

const INSTRUMENTED = /\buseNamedSource\s*\(/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".tsx") && !entry.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

describe("ui.network_named coverage", () => {
  const files = ROOTS.flatMap((r) => walk(path.join(WEB, r)));

  it("finds components to check (the walk itself works)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("every component that names a source reports it", () => {
    const missing: string[] = [];

    for (const file of files) {
      const rel = path.relative(WEB, file);
      if (rel in ALLOWLIST) continue;

      const source = readFileSync(file, "utf8");
      const names = RENDERS_A_SOURCE_NAME.some((re) => re.test(source));
      if (names && !INSTRUMENTED.test(source)) missing.push(rel);
    }

    expect(
      missing,
      missing.length
        ? `These render a source's proper name but do not call useNamedSource, so ` +
            `sessions that see a name would be counted clean:\n  ${missing.join("\n  ")}\n` +
            `Add the hook, or add an entry to ALLOWLIST in this file WITH a reason.`
        : "",
    ).toEqual([]);
  });

  it("every allowlist entry still exists and still names a source", () => {
    for (const [rel, reason] of Object.entries(ALLOWLIST)) {
      const full = path.join(WEB, rel);
      const source = readFileSync(full, "utf8"); // throws if the file moved
      expect(reason.length, `${rel} needs a real reason`).toBeGreaterThan(30);
      expect(
        RENDERS_A_SOURCE_NAME.some((re) => re.test(source)),
        `${rel} no longer names a source — drop it from ALLOWLIST`,
      ).toBe(true);
    }
  });
});
