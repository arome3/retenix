// Regenerates packages/shared/src/retenix-policy.abi.ts from the forge build
// artifact. Run after any RetenixPolicy surface change:
//   cd contracts && forge build && node script/export-abi.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const artifact = resolve(here, "../out/RetenixPolicy.sol/RetenixPolicy.json");
const target = resolve(here, "../../packages/shared/src/retenix-policy.abi.ts");

const { abi } = JSON.parse(readFileSync(artifact, "utf8"));
const body = JSON.stringify(abi, null, 2);
writeFileSync(
  target,
  `// GENERATED — do not edit. Source of truth: contracts/src/RetenixPolicy.sol.
// Regenerate: cd contracts && forge build && node script/export-abi.mjs
export const RETENIX_POLICY_ABI = ${body} as const;
`,
);
console.log(`wrote ${target} (${abi.length} ABI entries)`);
