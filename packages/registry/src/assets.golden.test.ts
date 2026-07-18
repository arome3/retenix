import { describe, expect, it } from "vitest";
import { REGISTRY, REGISTRY_IDS } from "./assets";

// ── GOLDEN PINS ──────────────────────────────────────────────────────────────
// A DELIBERATE SECOND COPY of the 5 spec-pinned xStocks mints (tech spec §3),
// hardcoded here so an accidental edit to assets.ts fails this test. This file
// is the ONLY sanctioned second copy of asset truth (doc 05). Do NOT "sync"
// these from assets.ts — that would defeat the guard.
const GOLDEN_MINTS: Record<string, string> = {
  tslax: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  aaplx: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
  nvdax: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  spyx: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
  qqqx: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ",
};

// The 5 TO PIN mints verified 2026-07-12 (≥2 independent sources; see the
// evidence comments in assets.ts). Golden-pinned here too so an accidental edit
// forces a re-run of the verification procedure (the PR-checklist rule).
const VERIFIED_TO_PIN_MINTS: Record<string, string> = {
  msftx: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",
  amznx: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg",
  googlx: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
  metax: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
  mstrx: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
};

const ALL_EQUITY_MINTS: Record<string, string> = {
  ...GOLDEN_MINTS,
  ...VERIFIED_TO_PIN_MINTS,
};

// ── GOLD PINS (doc 20) ───────────────────────────────────────────────────────
// A DELIBERATE SECOND COPY of the tokenized-gold contract address(es), hardcoded
// here so an accidental edit to assets.ts fails this test. THERE IS NO
// `Xs`-PREFIX TRIPWIRE FOR ERC-20s (unlike Solana xStocks mints): this pin, the
// issuer-page verification recorded in assets.ts, and this golden copy are the
// ENTIRE fake-contract defense (G-R2). Verified 2026-07-17 against Paxos's own
// repo README + the issuer-verified Etherscan token page.
const GOLD_TOKENS: Record<string, string> = {
  paxg: "0x45804880De22913dAFE09f4980848ECE6EcbAf78",
};

// XAUT (Tether Gold) is DEFERRED until a passing G-R1. When it is pinned, its
// current address is 0x68749665FF8D2d112Fa859AA293F07A622782F38 (HANDOFF §20) —
// but this is the DEPRECATED old contract, which carries Etherscan's "Tether
// Gold: Old XAUt Token" tag and an on-chain migration notice. It is genuinely
// Tether-issued yet dead — exactly the failure a prefix tripwire could not catch —
// so it must NEVER enter the registry. This negative pin guards that forever.
const DEPRECATED_XAUT = "0x4922a015c4407F87432B179bb209e125432E4a2A";

// ── LEVERAGED PINS (doc 18 F11) ──────────────────────────────────────────────
// A DELIBERATE SECOND COPY of the Shift Series Token mints. The `SHFT` suffix is
// a WEAKER tripwire than `Xs` — module 20 proved a vanity affix cannot catch a
// genuine-but-dead issuer address — so this pin carries more of the defensive
// weight than the equity pins do. Verified 2026-07-18 against 2 independent
// sources (Jupiter verified-list metadata on an issuer-controlled domain +
// Solana RPC getAccountInfo). Do NOT "sync" from assets.ts.
const SHIFT_MINTS: Record<string, string> = {
  tsl2l: "6afjZE5Qv9WF5K1adBgTxtWyenJ7ZerH6BVAzmoSHFT",
  tsl1s: "bNPXng6hSVas7LWiNQyvpGcPYtY1ZmFY6WP49ymSHFT",
  spx3l: "12y35E6btjazuaSjjwq99MobbycbkFsFvm8s5QpaSHFT",
  spx3s: "67ik3PpEXBJA1km29rZMMKwhgvvjrKpNMoaZyTsSHFT",
  sox3l: "Hyhxfb6riaqCV333GynmnCXCEQK3goTznFj7k4dSHFT",
  sox3s: "7GoxZQ7gCh1mg1b3AUqd7cyPqiUp4y2NRxM9A5zSHFT",
};

// The three live SpaceX Series Tokens are DELIBERATELY EXCLUDED (assets.ts
// scope note): doc 18 F11 scopes F11 to the TSLA/NVDA/SPY family, and SpaceX is
// a PRIVATE company whose 1:1 Alpaca-backed custody story does not obviously
// hold. They are real, issuer-published, Jupiter-verified mints — which is
// exactly why a negative pin is warranted: nothing about them looks wrong at a
// glance, so the guard has to be explicit rather than relying on reviewer
// memory. Admitting them is a separate decision with its own verification.
const EXCLUDED_SPACEX_MINTS: Record<string, string> = {
  spcx1l: "HMtfKJDqiAbY6damtfGisodK4sotG4Vc3wiLmTXmSHFT",
  spcx2l: "BcVDiSc5DTp8imZE4Nx2abUhhgA3KCxJ4M5g7aHLSHFT",
  spcx2s: "FtBpBcLU4Epjm2nnuQNRYGkFM6jfsXrcGKJSiKCtSHFT",
};

const byId = (id: string) => REGISTRY.find((a) => a.id === id);

describe("golden pins (defense against accidental assets.ts edits)", () => {
  it.each(Object.entries(GOLDEN_MINTS))(
    "spec-pinned %s mint matches byte-for-byte",
    (id, address) => {
      expect(byId(id)?.address).toBe(address);
    },
  );

  it.each(Object.entries(VERIFIED_TO_PIN_MINTS))(
    "verified TO-PIN %s mint matches byte-for-byte",
    (id, address) => {
      expect(byId(id)?.address).toBe(address);
    },
  );

  it("every equity mint starts with the Xs prefix and is valid base58", () => {
    for (const address of Object.values(ALL_EQUITY_MINTS)) {
      expect(address.startsWith("Xs")).toBe(true);
      expect(address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    }
  });

  it("REGISTRY's equity set is exactly the golden + verified mints (no extras)", () => {
    const registryEquityMints = REGISTRY.filter((a) => a.kind === "equity")
      .map((a) => a.address)
      .sort();
    expect(registryEquityMints).toEqual(Object.values(ALL_EQUITY_MINTS).sort());
  });

  it("SOL and ETH use the 0x00…00 native sentinel on their chains", () => {
    expect(byId("sol")?.address).toBe("0x0000000000000000000000000000000000000000");
    expect(byId("sol")?.chainId).toBe(101);
    expect(byId("eth")?.address).toBe("0x0000000000000000000000000000000000000000");
    expect(byId("eth")?.chainId).toBe(1);
  });

  it.each(Object.entries(GOLD_TOKENS))(
    "gold %s contract matches byte-for-byte (the pin IS the defense — no Xs tripwire)",
    (id, address) => {
      expect(byId(id)?.address).toBe(address);
    },
  );

  it("the DEPRECATED old XAUT contract is NEVER in the registry (negative pin)", () => {
    const dead = DEPRECATED_XAUT.toLowerCase();
    for (const a of REGISTRY) {
      expect(a.address.toLowerCase(), `${a.id} must not be the dead XAUT`).not.toBe(
        dead,
      );
    }
  });

  it.each(Object.entries(SHIFT_MINTS))(
    "leveraged %s mint matches byte-for-byte (the pin carries the weight — SHFT is a weak tripwire)",
    (id, address) => {
      expect(byId(id)?.address).toBe(address);
    },
  );

  it("every leveraged mint ends with the SHFT suffix and is valid base58", () => {
    for (const address of Object.values(SHIFT_MINTS)) {
      expect(address.endsWith("SHFT")).toBe(true);
      expect(address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    }
  });

  it("REGISTRY's leveraged set is exactly the Shift mints (no extras)", () => {
    const registryLeveragedMints = REGISTRY.filter((a) => a.kind === "leveraged")
      .map((a) => a.address)
      .sort();
    expect(registryLeveragedMints).toEqual(Object.values(SHIFT_MINTS).sort());
  });

  it("the excluded SpaceX Series Tokens are NEVER in the registry (negative pin)", () => {
    const excluded = new Set(
      Object.values(EXCLUDED_SPACEX_MINTS).map((a) => a.toLowerCase()),
    );
    for (const a of REGISTRY) {
      expect(
        excluded.has(a.address.toLowerCase()),
        `${a.id}: SpaceX Series Tokens are out of doc 18 F11 scope — admitting one needs its own verification, not a silent row`,
      ).toBe(false);
    }
  });
});

describe("registry invariants (doc 05 contract)", () => {
  const equities = () => REGISTRY.filter((a) => a.kind === "equity");
  const cryptos = () => REGISTRY.filter((a) => a.kind === "crypto");

  it("every equity carries a disclosure, Backed issuer, NON_RESTRICTED gate, chain 101", () => {
    for (const a of equities()) {
      expect(a.disclosure, `${a.ticker} disclosure`).toBeTruthy();
      expect(a.disclosure).toContain(
        "It is not a share — no voting rights or dividend claims. Issuer: Backed.",
      );
      expect(a.issuer).toBe("Backed");
      expect(a.eligibleRegions).toBe("NON_RESTRICTED");
      expect(a.chainId).toBe(101);
    }
  });

  it("every crypto asset is ALL-region with no equity-only fields", () => {
    for (const a of cryptos()) {
      expect(a.eligibleRegions).toBe("ALL");
      expect(a.disclosure).toBeUndefined();
      expect(a.issuer).toBeUndefined();
    }
  });

  const golds = () => REGISTRY.filter((a) => a.kind === "rwa-gold");

  it("every gold asset is NON_SANCTIONED, Ethereum (1), with issuer + disclosure + decimals", () => {
    expect(golds().length).toBeGreaterThan(0); // PAXG present
    for (const a of golds()) {
      expect(a.eligibleRegions).toBe("NON_SANCTIONED");
      expect(a.chainId).toBe(1);
      expect(a.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(a.disclosure, `${a.ticker} disclosure`).toBeTruthy();
      expect(a.issuer).toBeTruthy();
      expect(typeof a.decimals).toBe("number");
    }
  });

  it("PAXG carries its verbatim gold disclosure and 18 decimals (G12: 'gold', never 'RWA')", () => {
    const paxg = byId("paxg");
    expect(paxg?.disclosure).toBe(
      "PAXG tracks physical gold held by Paxos. It is a token claim, not vault access. Issuer: Paxos.",
    );
    expect(paxg?.disclosure).not.toMatch(/\brwa\b/i);
    expect(paxg?.issuer).toBe("Paxos");
    expect(paxg?.decimals).toBe(18);
  });

  const leveraged = () => REGISTRY.filter((a) => a.kind === "leveraged");

  it("every leveraged asset is NON_RESTRICTED, Solana (101), Shift-issued, 8 decimals", () => {
    expect(leveraged().length).toBeGreaterThan(0);
    for (const a of leveraged()) {
      // At least as strict as xStocks (doc 18 F11) — and stricter than Shift's
      // own US/UK exclusion, which NON_RESTRICTED (US/CA/GB/AU) is a superset of.
      expect(a.eligibleRegions).toBe("NON_RESTRICTED");
      expect(a.chainId).toBe(101);
      expect(a.issuer).toBe("Shift");
      expect(a.decimals).toBe(8);
      expect(a.address.endsWith("SHFT"), `${a.ticker} SHFT suffix`).toBe(true);
    }
  });

  it("every leveraged disclosure carries the MANDATORY decay warning (doc 18 §Gotchas)", () => {
    for (const a of leveraged()) {
      expect(a.disclosure, `${a.ticker} disclosure`).toBeTruthy();
      expect(a.disclosure, `${a.ticker} decay warning`).toMatch(/\bdecays?\b/i);
      expect(a.disclosure).toContain("resets every day");
    }
  });

  it("leveraged disclosures never claim liquidation risk — Shift has no liquidation engine", () => {
    // Shift markets these as "zero liquidation risk / no forced close", so a
    // liquidation warning would be FALSE. Decay is the real hazard, and saying
    // the wrong true-sounding thing is its own compliance failure.
    for (const a of leveraged()) {
      expect(a.disclosure, `${a.ticker}`).not.toMatch(/liquidat/i);
    }
  });

  it("TSL2L carries its verbatim decay disclosure", () => {
    expect(byId("tsl2l")?.disclosure).toBe(
      "TSL2L targets 2× the daily move of Tesla. The target resets every day, so its value decays over longer holds and in choppy markets — it is built for short holds, not for holding through a drawdown. It is not a share — no voting rights or dividend claims. Issuer: Shift.",
    );
  });

  it("inverse tokens state a negative factor, not a positive one", () => {
    expect(byId("tsl1s")?.disclosure).toContain("targets −1× the daily move");
    expect(byId("spx3s")?.disclosure).toContain("targets −3× the daily move");
    expect(byId("sox3s")?.disclosure).toContain("targets −3× the daily move");
  });

  it("SPYx discloses the S&P 500 ETF", () => {
    expect(byId("spyx")?.disclosure).toContain("tracks the S&P 500 ETF");
  });

  it("QQQx discloses the Nasdaq-100 — factually correct, NOT the S&P 500 (HANDOFF deviation)", () => {
    expect(byId("qqqx")?.disclosure).toContain("tracks the Nasdaq-100 ETF");
    expect(byId("qqqx")?.disclosure).not.toContain("S&P 500");
  });

  it("REGISTRY_IDS is a non-empty tuple of unique lowercase ids", () => {
    expect(REGISTRY_IDS.length).toBeGreaterThan(0);
    expect(new Set(REGISTRY_IDS).size).toBe(REGISTRY_IDS.length);
    for (const id of REGISTRY_IDS) expect(id).toBe(id.toLowerCase());
  });

  it("REGISTRY_IDS mirrors REGISTRY order and membership (doc 09 z.enum input)", () => {
    expect(REGISTRY_IDS).toEqual(REGISTRY.map((a) => a.id));
  });

  it("the SPYx entry — the G2 buy target — is present and pinned", () => {
    const spyx = byId("spyx");
    expect(spyx?.address).toBe("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W");
    expect(spyx?.chainId).toBe(101);
    expect(spyx?.kind).toBe("equity");
  });
});
