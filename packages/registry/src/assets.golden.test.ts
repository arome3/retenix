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

const byId = (id: string) => REGISTRY.find((a) => a.id === id);

describe("golden pins (defense against accidental assets.ts edits)", () => {
  it.each(Object.entries(GOLDEN_MINTS))(
    "%s mint matches the pinned address byte-for-byte",
    (id, address) => {
      expect(byId(id)?.address).toBe(address);
    },
  );

  it("every pinned equity mint starts with the Xs prefix", () => {
    for (const address of Object.values(GOLDEN_MINTS)) {
      expect(address.startsWith("Xs")).toBe(true);
    }
  });

  it("SOL and ETH use the 0x00…00 native sentinel on their chains", () => {
    expect(byId("sol")?.address).toBe("0x0000000000000000000000000000000000000000");
    expect(byId("sol")?.chainId).toBe(101);
    expect(byId("eth")?.address).toBe("0x0000000000000000000000000000000000000000");
    expect(byId("eth")?.chainId).toBe(1);
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
