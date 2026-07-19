// Module 20 — position enumeration must INCLUDE tokenized gold (doc 20 §step 4:
// "assert, don't assume"). enumeratePositions itself is DB-backed (loadFills), so
// its ledger step is factored into the pure ledgerTrackedPositions(), tested here
// against a hand-built basis ledger. This is the kill switch's liquidation source
// (module 13 parity), so a gold buy MUST surface as a sellable position.
import { buildBasisLedger, type Fill } from "@retenix/shared";
import { describe, expect, it } from "vitest";
import { ledgerTrackedPositions } from "./holdings";

const buy = (assetId: string, usd: number, qty: number, at: string): Fill => ({
  side: "buy",
  assetId,
  usd,
  qty,
  at,
});

describe("ledgerTrackedPositions (crypto + rwa-gold, doc 20)", () => {
  it("surfaces a ledger-known gold (paxg) buy as a position", () => {
    const ledger = buildBasisLedger([buy("paxg", 40, 0.01, "2026-07-17T00:00:00Z")]);
    const positions = ledgerTrackedPositions(ledger);
    const gold = positions.find((p) => p.assetId === "paxg");
    expect(gold).toBeDefined();
    expect(gold?.qty).toBeCloseTo(0.01, 12);
    expect(gold?.qtyHuman).toBe(String(0.01));
  });

  it("still enumerates SOL/ETH alongside gold (no regression to the native path)", () => {
    const ledger = buildBasisLedger([
      buy("sol", 20, 0.1, "2026-07-17T00:00:00Z"),
      buy("eth", 30, 0.01, "2026-07-17T00:01:00Z"),
      buy("paxg", 40, 0.01, "2026-07-17T00:02:00Z"),
    ]);
    const ids = ledgerTrackedPositions(ledger)
      .map((p) => p.assetId)
      .sort();
    expect(ids).toEqual(["eth", "paxg", "sol"]);
  });

  it("never enumerates an equity here — equities come from the chain scan", () => {
    // A ledger entry for an equity must NOT be returned by this function (it is
    // the chain scanner's job); otherwise a Solana equity would double-count.
    const ledger = buildBasisLedger([buy("spyx", 60, 0.1, "2026-07-17T00:00:00Z")]);
    expect(ledgerTrackedPositions(ledger).some((p) => p.assetId === "spyx")).toBe(
      false,
    );
  });

  it("renders nothing for a poisoned (basis-unknown) gold ledger — never a guess", () => {
    // A sell of never-bought gold poisons the basis (known=false) — the position
    // must be withheld rather than stated (doc 12 §failure modes).
    const ledger = buildBasisLedger([
      { side: "sell", assetId: "paxg", usd: 40, qty: 0.01, at: "2026-07-17T00:00:00Z" },
    ]);
    expect(ledgerTrackedPositions(ledger).some((p) => p.assetId === "paxg")).toBe(
      false,
    );
  });

  it("drops a dust-sized gold position at/below the epsilon", () => {
    const ledger = buildBasisLedger([buy("paxg", 0, 0, "2026-07-17T00:00:00Z")]);
    expect(ledgerTrackedPositions(ledger).some((p) => p.assetId === "paxg")).toBe(
      false,
    );
  });
});
