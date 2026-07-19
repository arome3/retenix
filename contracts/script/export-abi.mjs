// Regenerates the shared ABI modules from the forge build artifacts. Run
// after any RetenixPolicy/RetenixClaim/RetenixHedge surface change:
//   cd contracts && forge build && node script/export-abi.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function exportAbi(contract, constName, targetFile) {
  const artifact = resolve(here, `../out/${contract}.sol/${contract}.json`);
  const target = resolve(here, `../../packages/shared/src/${targetFile}`);
  const { abi } = JSON.parse(readFileSync(artifact, "utf8"));
  const body = JSON.stringify(abi, null, 2);
  writeFileSync(
    target,
    `// GENERATED — do not edit. Source of truth: contracts/src/${contract}.sol.
// Regenerate: cd contracts && forge build && node script/export-abi.mjs
export const ${constName} = ${body} as const;
`,
  );
  console.log(`wrote ${target} (${abi.length} ABI entries)`);
}

exportAbi("RetenixPolicy", "RETENIX_POLICY_ABI", "retenix-policy.abi.ts");
exportAbi("RetenixClaim", "RETENIX_CLAIM_ABI", "retenix-claim.abi.ts");
exportAbi("RetenixHedge", "RETENIX_HEDGE_ABI", "retenix-hedge.abi.ts");
