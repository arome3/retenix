// Exact-pin guard (doc 00 §Implementation guide step 5, extended by doc 03 task 1).
// The two EXACT pins are load-bearing — no ^ or ~, never upgraded during the
// hackathon (gotcha G1). ci.yml's `pins` job runs this same file, so the check
// and its CI mirror can never drift.
//
//   magic-sdk           33.9.0   — lives in apps/web (doc 02 auth surface)
//   universal-account   2.0.3    — lives ONLY in packages/ua (doc 03: the single
//                                  integration layer; no other code may import or
//                                  touch the UA SDK — module 03 hard constraint)
import { readFileSync } from "node:fs";

const read = (rel) =>
  JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const deps = (pkg) => ({ ...pkg.dependencies, ...pkg.devDependencies });

const UA_SDK = "@particle-network/universal-account-sdk";
const web = deps(read("../apps/web/package.json"));
const ua = deps(read("../packages/ua/package.json"));

const errors = [];

// magic-sdk stays pinned EXACT in apps/web (doc 00 canonical version table).
if (web["magic-sdk"] && web["magic-sdk"] !== "33.9.0") {
  errors.push("magic-sdk must be pinned to 33.9.0 (apps/web/package.json)");
}

// The UA SDK is pinned EXACT and owned solely by packages/ua.
if (ua[UA_SDK] !== "2.0.3") {
  errors.push(
    `${UA_SDK} must be pinned to exactly 2.0.3 in packages/ua/package.json (found ${ua[UA_SDK] ?? "absent"})`,
  );
}

// Enforce the single-integration-layer rule mechanically: the SDK must never be
// a direct dependency of the web app — it consumes @retenix/ua instead.
if (web[UA_SDK]) {
  errors.push(
    `${UA_SDK} must not be a direct dependency of apps/web — consume @retenix/ua exclusively (found ${web[UA_SDK]})`,
  );
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log("pins ok");
