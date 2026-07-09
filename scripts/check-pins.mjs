// Local mirror of the verbatim pins check in .github/workflows/ci.yml
// (doc 00 §Implementation guide step 5). The two EXACT pins are load-bearing:
// no ^ or ~, never upgraded during the hackathon (gotcha G1).
import { readFileSync } from "node:fs";

const w = JSON.parse(
  readFileSync(new URL("../apps/web/package.json", import.meta.url), "utf8"),
);
for (const [k, v] of Object.entries({
  "@particle-network/universal-account-sdk": "2.0.3",
  "magic-sdk": "33.9.0",
})) {
  const d = { ...w.dependencies, ...w.devDependencies };
  if (d[k] && d[k] !== v) {
    console.error(k + " must be pinned to " + v);
    process.exit(1);
  }
}
console.log("pins ok");
