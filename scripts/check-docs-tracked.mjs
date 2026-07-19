// Private-docs guard (doc 17 §Repo hygiene).
//
// github.com/arome3/retenix is PUBLIC. On 2026-07-10 the owner moved every plan
// and prompt off git — docs/ and nine root planning files were gitignored and
// purged from history with filter-repo. Four docs/ files are deliberate
// exceptions because judges must read them (TS-15.7: "bounty writeups in
// /docs"); everything else in that folder is private strategy.
//
// A `git add -f`, an over-broad negation in .gitignore, or a well-meaning
// `git add -A` after someone edits the ignore rules would publish the lot, and
// nothing else in CI would notice. This turns that into a red build.
import { execFileSync } from "node:child_process";

// Judge-facing by requirement. Nothing may be added here without the owner
// deciding it is public — the whole point of the file is that the list is small
// enough to review.
const PUBLIC_DOCS = new Set([
  "docs/writeup-ua-track.md",
  "docs/writeup-arbitrum.md",
  "docs/writeup-magic.md",
  "docs/deployments.md",
]);

// The nine root planning files purged in the same decision (blueprints, specs,
// prompt sources). Listed explicitly rather than globbed: a new root *.md is
// usually a README, and should not silently inherit a ban.
const PRIVATE_ROOT_FILES = [
  "broker-agent-blueprint.md",
  "heirloom-blueprint.md",
  "retenix-blueprint.md",
  "retenix-claude-code-prompt.md",
  "retenix-design-system.md",
  "retenix-execution-prompts-generator.md",
  "retenix-product-spec.md",
  "retenix-technical-spec.md",
  "uxmaxx-hackathon-strategy.md",
];

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);

const errors = [];

for (const tracked of git("ls-files", "docs")) {
  if (!PUBLIC_DOCS.has(tracked)) {
    errors.push(
      `${tracked} is TRACKED but docs/ is private — the repo is public. ` +
        `Either it belongs in scripts/check-docs-tracked.mjs's PUBLIC_DOCS ` +
        `(an owner decision), or run: git rm --cached "${tracked}"`,
    );
  }
}

for (const file of PRIVATE_ROOT_FILES) {
  if (git("ls-files", "--", file).length) {
    errors.push(`${file} is TRACKED — it was purged from history on 2026-07-10`);
  }
}

if (errors.length) {
  console.error("private docs: FAILED");
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

const published = git("ls-files", "docs");
console.log(
  `private docs ok — ${published.length}/${PUBLIC_DOCS.size} public file(s) tracked, ` +
    `nothing else under docs/`,
);
