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
