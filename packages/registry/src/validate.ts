// Fake-mint guard (doc 05, G11). Runs at module load via assets.ts AND as a
// vitest — importing the registry with a bad entry throws at build/test time,
// never as a runtime surprise during a live buy.
//
// The `Xs` prefix is only a TRIPWIRE (an attacker can vanity-grind `Xs…`); the
// pinned address list in assets.ts is the real defense. This function enforces
// the prefix, the Solana-101 invariant, the equity disclosure/eligibility
// invariants, and id uniqueness.
import { XS_PREFIX, type RegistryAsset } from "./assets";

export function validateRegistry(reg: readonly RegistryAsset[]) {
  for (const a of reg) {
    if (a.kind === "equity") {
      if (!a.address.startsWith(XS_PREFIX))
        throw new Error(`FAKE-MINT GUARD: ${a.ticker} mint lacks Xs prefix`);
      if (a.chainId !== 101)
        throw new Error(`${a.ticker}: xStocks are Solana SPL mints`);
      if (!a.disclosure || a.eligibleRegions !== "NON_RESTRICTED")
        throw new Error(`${a.ticker}: equity invariants`);
    }
  }
  const ids = new Set(reg.map((a) => a.id));
  if (ids.size !== reg.length) throw new Error("duplicate asset ids");
}
