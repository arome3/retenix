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
    } else if (a.kind === "rwa-gold") {
      // Tokenized gold (doc 20). No `Xs` tripwire exists for ERC-20s — the pin
      // list IS the defense — so these load-time invariants are the fail-fast
      // parity equities get: a bad gold row throws at import, not during a buy.
      if (a.chainId !== 1)
        throw new Error(`${a.ticker}: rwa-gold is an Ethereum ERC-20 (chain 1)`);
      if (!/^0x[0-9a-fA-F]{40}$/.test(a.address))
        throw new Error(`${a.ticker}: rwa-gold address must be a 0x ERC-20 contract`);
      if (!a.disclosure)
        throw new Error(`${a.ticker}: rwa-gold requires a disclosure line`);
      if (a.eligibleRegions !== "NON_SANCTIONED")
        throw new Error(`${a.ticker}: rwa-gold must be NON_SANCTIONED (doc 20 OQ-R2)`);
      if (!a.issuer)
        throw new Error(`${a.ticker}: rwa-gold requires a named issuer`);
      // Require a positive decimals (PAXG 18, XAUT 6) — the golden test pins the
      // exact value per token; here we only enforce that one was declared.
      if (typeof a.decimals !== "number" || a.decimals <= 0)
        throw new Error(`${a.ticker}: rwa-gold requires positive decimals`);
    }
  }
  const ids = new Set(reg.map((a) => a.id));
  if (ids.size !== reg.length) throw new Error("duplicate asset ids");
}
