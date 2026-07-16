import { describe, expect, it, vi } from "vitest";
import {
  getMarks,
  jupiterMintFor,
  JUPITER_PRICE_URL,
  type MarkAssetInput,
} from "./marks";
import { SOL_NATIVE_MINT } from "./portfolio";

const SPYX_MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

const SPYX: MarkAssetInput = { id: "spyx", chainId: 101, address: SPYX_MINT };
const SOL: MarkAssetInput = {
  id: "sol",
  chainId: 101,
  address: "0x0000000000000000000000000000000000000000",
};
const ETH: MarkAssetInput = {
  id: "eth",
  chainId: 1,
  address: "0x0000000000000000000000000000000000000000",
};

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;

describe("jupiterMintFor", () => {
  it("equity mints pass through; SOL maps to the native mint; ETH is not priceable", () => {
    expect(jupiterMintFor(SPYX)).toBe(SPYX_MINT);
    expect(jupiterMintFor(SOL)).toBe(SOL_NATIVE_MINT);
    expect(jupiterMintFor(ETH)).toBeNull();
  });
});

describe("getMarks", () => {
  it("prices SPL assets live from Jupiter (stale=false)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okJson({
        [SPYX_MINT]: { usdPrice: 625.4 },
        [SOL_NATIVE_MINT]: { usdPrice: 147.5 },
      }),
    );
    const marks = await getMarks({
      assets: [SPYX, SOL],
      source: "jupiter",
      lastTrade: new Map(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(marks.get("spyx")).toEqual({ usd: 625.4, stale: false, source: "jupiter" });
    expect(marks.get("sol")).toEqual({ usd: 147.5, stale: false, source: "jupiter" });
    const url = (fetchImpl.mock.calls[0] as [string])[0];
    expect(url.startsWith(`${JUPITER_PRICE_URL}?ids=`)).toBe(true);
    expect(url).toContain(SPYX_MINT);
    expect(url).toContain(SOL_NATIVE_MINT);
  });

  it("a mint Jupiter omits falls back to last-trade with the stale flag", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okJson({ [SOL_NATIVE_MINT]: { usdPrice: 147.5 } }));
    const marks = await getMarks({
      assets: [SPYX, SOL],
      source: "jupiter",
      lastTrade: new Map([["spyx", 600]]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(marks.get("spyx")).toEqual({ usd: 600, stale: true, source: "last-trade" });
    expect(marks.get("sol")?.stale).toBe(false);
  });

  it("no live price and no last trade → asset absent (never fabricated)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({}));
    const marks = await getMarks({
      assets: [SPYX],
      source: "jupiter",
      lastTrade: new Map(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(marks.has("spyx")).toBe(false);
  });

  it("whole-fetch failure and non-200 both degrade everything to last-trade", async () => {
    for (const impl of [
      vi.fn().mockRejectedValue(new Error("network down")),
      vi.fn().mockResolvedValue({ ok: false, status: 429 } as Response),
    ]) {
      const marks = await getMarks({
        assets: [SPYX, SOL],
        source: "jupiter",
        lastTrade: new Map([
          ["spyx", 600],
          ["sol", 140],
        ]),
        fetchImpl: impl as unknown as typeof fetch,
      });
      expect(marks.get("spyx")).toEqual({ usd: 600, stale: true, source: "last-trade" });
      expect(marks.get("sol")).toEqual({ usd: 140, stale: true, source: "last-trade" });
    }
  });

  it("ETH never rides the Jupiter call — last-trade only, even under source=jupiter", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({}));
    const marks = await getMarks({
      assets: [ETH],
      source: "jupiter",
      lastTrade: new Map([["eth", 3200]]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // No SPL mints requested → no fetch at all.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(marks.get("eth")).toEqual({ usd: 3200, stale: true, source: "last-trade" });
  });

  it("source=last-trade never touches the network", async () => {
    const fetchImpl = vi.fn();
    const marks = await getMarks({
      assets: [SPYX],
      source: "last-trade",
      lastTrade: new Map([["spyx", 610]]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(marks.get("spyx")).toEqual({ usd: 610, stale: true, source: "last-trade" });
  });

  it("rejects nonsensical live prices (0, negative, non-number) per asset", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okJson({
        [SPYX_MINT]: { usdPrice: 0 },
        [SOL_NATIVE_MINT]: { usdPrice: "147" },
      }),
    );
    const marks = await getMarks({
      assets: [SPYX, SOL],
      source: "jupiter",
      lastTrade: new Map([["spyx", 600]]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(marks.get("spyx")?.source).toBe("last-trade");
    expect(marks.has("sol")).toBe(false);
  });
});
