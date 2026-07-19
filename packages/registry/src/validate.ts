// Fake-mint guard (doc 05, G11). Runs at module load via assets.ts AND as a
// vitest — importing the registry with a bad entry throws at build/test time,
// never as a runtime surprise during a live buy.
//
// The `Xs` prefix is only a TRIPWIRE (an attacker can vanity-grind `Xs…`); the
// pinned address list in assets.ts is the real defense. This function enforces
// the prefix, the Solana-101 invariant, the equity disclosure/eligibility
// invariants, and id uniqueness.
//
// EXHAUSTIVENESS (doc 18): the branch chain below ends in a `never` check, so
// widening AssetKind without adding a validation branch is a COMPILE error
// (`tsc -b`), not a row that silently loads unvalidated. Before doc 18 the
// chain simply fell through — a new kind was accepted with zero checks.
import { SHFT_SUFFIX, XS_PREFIX, type RegistryAsset } from "./assets";

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
    } else if (a.kind === "leveraged") {
      // Shift RWA Series Tokens (doc 18 F11). Solana SPL mints reached by the
      // UNCHANGED createBuyTransaction pipeline — same program and same
      // Token-2022 extension profile as xStocks, verified on-chain 2026-07-18
      // — but a different issuer and a decay profile spot equities do not have,
      // so they get their own kind rather than an `equity` flag.
      //
      // ⚠️  The shared `SHFT` suffix is a WEAKER tripwire than `Xs`, not an
      //     equal one: module 20 recorded that a vanity affix cannot catch a
      //     genuine-but-DEAD issuer address (the deprecated XAUT). The pinned
      //     list + the golden test remain the entire defense.
      if (!a.address.endsWith(SHFT_SUFFIX))
        throw new Error(
          `FAKE-MINT GUARD: ${a.ticker} mint lacks ${SHFT_SUFFIX} suffix`,
        );
      if (a.chainId !== 101)
        throw new Error(`${a.ticker}: Series Tokens are Solana SPL mints`);
      if (!a.issuer)
        throw new Error(`${a.ticker}: leveraged requires a named issuer`);
      if (typeof a.decimals !== "number" || a.decimals <= 0)
        throw new Error(`${a.ticker}: leveraged requires positive decimals`);
      // At least as strict as xStocks (doc 18 F11) — and stricter than the
      // issuer's own US/UK exclusion, which NON_RESTRICTED is a superset of.
      if (a.eligibleRegions !== "NON_RESTRICTED")
        throw new Error(
          `${a.ticker}: leveraged must be at least as strict as xStocks (NON_RESTRICTED)`,
        );
      // The decay warning is MANDATORY COPY (doc 18 §Gotchas), so assert the
      // warning is actually PRESENT — not merely that some disclosure exists.
      // Shift markets these as "zero liquidation risk", so decay/rebalancing is
      // the real hazard and liquidation wording would be actively false.
      if (!a.disclosure)
        throw new Error(`${a.ticker}: leveraged requires a decay disclosure`);
      if (!/\bdecays?\b/i.test(a.disclosure))
        throw new Error(
          `${a.ticker}: leveraged disclosure must carry the decay warning (doc 18)`,
        );
    } else if (a.kind === "crypto") {
      // Native crypto: the address is the 0x000…000 sentinel passed through to
      // UA verbatim (doc 05), so there is no address shape to enforce. This
      // branch is deliberately empty but deliberately NAMED — without it the
      // exhaustiveness check below would reject crypto rows.
    } else {
      // Unreachable while every AssetKind has a branch above. If this stops
      // compiling, a kind was added to the union without validation — add the
      // branch, never widen this cast (doc 18: an unvalidated kind is exactly
      // the fake-mint hole the whole file exists to close).
      const unhandled: never = a.kind;
      throw new Error(
        `${a.ticker}: no validation branch for asset kind "${String(unhandled)}"`,
      );
    }
  }
  const ids = new Set(reg.map((a) => a.id));
  if (ids.size !== reg.length) throw new Error("duplicate asset ids");
}
