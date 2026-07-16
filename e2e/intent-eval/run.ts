// The 25-utterance intent eval (doc 09, PS-F3-AC1) — `pnpm eval:intent`.
//
// Modes:
//   (default)   replay RECORDED model outputs (fixtures.json) through the real
//               deterministic pipeline — the CI job; no key, no DB, no drift.
//   --live      call the real model per utterance (the manual gate before the
//               demo; model responses drift, so live is never the CI mode).
//   --record    --live, then overwrite fixtures.json with what the model said.
//
// Scoring (spec): exact match on the normalized draft (adviceFooter included)
// or a decline; >=24/25 passes. An "unavailable" outcome (timeout/outage)
// NEVER scores as a pass — infra noise must not masquerade as a verdict.
//
// The pipeline under test is the production one: resolveParse from
// apps/web/server/lib/draft.ts — the eval measures exactly what intent.parse
// serves.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenv } from "dotenv";
import {
  resolveParse,
  regionAssetIds,
  regionDraftSchema,
  type ParseOutcome,
  type ResolvedParse,
} from "../../apps/web/server/lib/draft";
import { RETENIX_INTENT_SYSTEM } from "../../apps/web/server/lib/intent-system";
import {
  INTENT_TIMEOUT_MS,
  intentModel,
  parseIntent,
} from "../../apps/web/server/lib/parse-intent";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

interface ExpectDraft {
  kind: "draft";
  adviceFooter: boolean;
  draft: unknown;
}
interface ExpectDecline {
  kind: "decline";
}
interface Utterance {
  id: string;
  coverage: string;
  text: string;
  expect: ExpectDraft | ExpectDecline;
}
interface EvalFile {
  region: string;
  utterances: Utterance[];
}
interface FixtureFile {
  recordedAt: string;
  model: string;
  region: string;
  /** True while the fixtures are hand-authored (no valid key to record with). */
  synthetic?: boolean;
  note?: string;
  outcomes: Record<string, ParseOutcome>;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function judge(
  u: Utterance,
  resolved: ResolvedParse,
): { pass: boolean; note: string } {
  if (u.expect.kind === "decline") {
    if (resolved.kind !== "decline") {
      return { pass: false, note: "expected a decline, got a draft" };
    }
    if (resolved.cause === "unavailable") {
      return { pass: false, note: "unavailable (infra) — not a parse verdict" };
    }
    return { pass: true, note: `decline (${resolved.cause})` };
  }
  if (resolved.kind !== "draft") {
    return {
      pass: false,
      note: `expected a draft, got decline (${resolved.cause})`,
    };
  }
  if (!deepEqual(resolved.draft, u.expect.draft)) {
    return {
      pass: false,
      note: `draft mismatch — got ${JSON.stringify(resolved.draft)}`,
    };
  }
  if (resolved.adviceFooter !== u.expect.adviceFooter) {
    return {
      pass: false,
      note: `adviceFooter ${resolved.adviceFooter}, expected ${u.expect.adviceFooter}`,
    };
  }
  return { pass: true, note: "draft exact-match" };
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live") || process.argv.includes("--record");
  const record = process.argv.includes("--record");

  const evalFile = JSON.parse(
    readFileSync(join(here, "utterances.json"), "utf8"),
  ) as EvalFile;
  const { region, utterances } = evalFile;
  const ids = regionAssetIds(region);

  let getOutcome: (u: Utterance) => Promise<ParseOutcome>;

  if (live) {
    // The server's key, loaded the way the app tooling loads it (root .env +
    // apps/web/.env.local — module 02's env-location note).
    dotenv({
      path: [join(repoRoot, ".env"), join(repoRoot, "apps/web/.env.local")],
      quiet: true,
    });
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || !apiKey.startsWith("sk-ant-")) {
      console.error(
        "eval:intent --live needs a real ANTHROPIC_API_KEY (apps/web/.env.local). " +
          "Owner-action: set it, then re-run `pnpm eval:intent --record`.",
      );
      process.exit(1);
    }
    const model = intentModel(apiKey);
    const schema = regionDraftSchema(region);
    const system = RETENIX_INTENT_SYSTEM(ids);
    getOutcome = (u) =>
      parseIntent({
        model,
        schema,
        system,
        prompt: u.text,
        timeoutMs: INTENT_TIMEOUT_MS,
      });
  } else {
    let fixtures: FixtureFile;
    try {
      fixtures = JSON.parse(
        readFileSync(join(here, "fixtures.json"), "utf8"),
      ) as FixtureFile;
    } catch {
      console.error(
        "fixtures.json missing/unreadable — record it once with " +
          "`pnpm eval:intent --record` (needs a real ANTHROPIC_API_KEY).",
      );
      process.exit(1);
    }
    if (fixtures.synthetic) {
      console.warn(
        "\n  ⚠ fixtures.json is SYNTHETIC (hand-authored) — this run proves the\n" +
          "    deterministic pipeline, NOT live model accuracy. Owner-action:\n" +
          "    set a real ANTHROPIC_API_KEY and `pnpm eval:intent --record`.",
      );
    }
    getOutcome = (u) => {
      const outcome = fixtures.outcomes[u.id];
      if (!outcome) {
        console.error(`fixtures.json has no outcome for ${u.id} — re-record.`);
        process.exit(1);
      }
      return Promise.resolve(outcome);
    };
  }

  const recorded: Record<string, ParseOutcome> = {};
  let passed = 0;
  const rows: string[] = [];

  for (const u of utterances) {
    const outcome = await getOutcome(u);
    recorded[u.id] = outcome;
    const resolved = resolveParse(outcome, { region, utterance: u.text });
    const { pass, note } = judge(u, resolved);
    if (pass) passed += 1;
    rows.push(`${pass ? "PASS" : "FAIL"}  ${u.id.padEnd(28)} ${note}`);
  }

  console.log(`\nintent eval — ${live ? "LIVE model" : "recorded fixtures"} (region ${region})\n`);
  for (const r of rows) console.log(`  ${r}`);
  console.log(`\n  score: ${passed}/${utterances.length} (AC1 needs >= 24)\n`);

  if (record) {
    const unavailable = Object.entries(recorded)
      .filter(([, o]) => o.kind === "unavailable")
      .map(([id]) => id);
    if (unavailable.length > 0) {
      console.error(
        `NOT recording: infra-noise outcomes for ${unavailable.join(", ")} — re-run --record.`,
      );
      process.exit(1);
    }
    const fixture: FixtureFile = {
      recordedAt: new Date().toISOString(),
      model: "claude-sonnet-4-5",
      region,
      synthetic: false,
      note: "Recorded from the live model by `pnpm eval:intent --record`.",
      outcomes: recorded,
    };
    writeFileSync(
      join(here, "fixtures.json"),
      `${JSON.stringify(fixture, null, 2)}\n`,
    );
    console.log("  fixtures.json recorded.\n");
  }

  process.exit(passed >= 24 ? 0 : 1);
}

void main();
