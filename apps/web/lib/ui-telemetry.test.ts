import { beforeEach, describe, expect, it, vi } from "vitest";

const sourceNamed = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const sessionStarted = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("@/lib/trpc-telemetry", () => ({
  trpcTelemetry: { telemetry: { sourceNamed: { mutate: sourceNamed }, sessionStarted: { mutate: sessionStarted } } },
}));

/** In-memory sessionStorage; `broken` simulates private mode. */
function installStorage(broken = false) {
  const map = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => {
      if (broken) throw new Error("storage disabled");
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error("storage disabled");
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
  });
  return map;
}

async function freshModule() {
  vi.resetModules(); // clears the module-level Set — i.e. simulates a page load
  return import("@/lib/ui-telemetry");
}

beforeEach(() => {
  sourceNamed.mockClear();
  sessionStarted.mockClear();
  vi.unstubAllGlobals();
});

describe("reportNamed", () => {
  it("reports once and dedupes within a page load", async () => {
    installStorage();
    const { reportNamed } = await freshModule();
    expect(reportNamed("breakdown")).toBe(true);
    expect(reportNamed("breakdown")).toBe(false);
    expect(reportNamed("breakdown")).toBe(false);
    expect(sourceNamed).toHaveBeenCalledTimes(1);
  });

  it("treats each surface independently", async () => {
    installStorage();
    const { reportNamed } = await freshModule();
    reportNamed("breakdown");
    reportNamed("withdraw");
    expect(sourceNamed).toHaveBeenCalledTimes(2);
  });

  // The layer that matters most: a reload clears the module Set, and only
  // sessionStorage stops the same session being counted twice.
  it("still dedupes across a reload — this is what makes it a SESSION event", async () => {
    installStorage();
    const first = await freshModule();
    expect(first.reportNamed("breakdown")).toBe(true);

    const afterReload = await freshModule(); // module state gone, storage kept
    expect(afterReload.reportNamed("breakdown")).toBe(false);
    expect(sourceNamed).toHaveBeenCalledTimes(1);
  });

  it("sends exactly {sid, surface} — no path, no address, no PII", async () => {
    installStorage();
    const { reportNamed } = await freshModule();
    reportNamed("receipt");
    const [payload] = sourceNamed.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(Object.keys(payload).sort()).toEqual(["sid", "surface"]);
    expect(payload["surface"]).toBe("receipt");
    expect(String(payload["sid"])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("survives private mode, where storage throws", async () => {
    installStorage(true);
    const { reportNamed } = await freshModule();
    expect(() => reportNamed("breakdown")).not.toThrow();
    // Layer 1 still holds within the load; layer 3 (the server guard) covers reloads.
    expect(reportNamed("breakdown")).toBe(false);
    expect(sourceNamed).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejected send — telemetry must never surface into React", async () => {
    installStorage();
    sourceNamed.mockRejectedValueOnce(new Error("401"));
    const { reportNamed } = await freshModule();
    expect(() => reportNamed("kill")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("sessionId", () => {
  it("mints once and stays stable across calls", async () => {
    installStorage();
    const { sessionId } = await freshModule();
    expect(sessionId()).toBe(sessionId());
  });

  it("is shared by every event in the session", async () => {
    installStorage();
    const { reportNamed, reportSessionStart, sessionId } = await freshModule();
    reportSessionStart();
    reportNamed("breakdown");
    const sid = sessionId();
    expect((sessionStarted.mock.calls[0] as never as [{ sid: string }])[0].sid).toBe(sid);
    expect((sourceNamed.mock.calls[0] as never as [{ sid: string }])[0].sid).toBe(sid);
  });
});

describe("reportSessionStart", () => {
  it("fires once per session, and again only after the session ends", async () => {
    installStorage();
    const first = await freshModule();
    expect(first.reportSessionStart()).toBe(true);
    expect(first.reportSessionStart()).toBe(false);

    const afterReload = await freshModule();
    expect(afterReload.reportSessionStart()).toBe(false);
    expect(sessionStarted).toHaveBeenCalledTimes(1);
  });

  it("carries the onboarding sid when one is still present", async () => {
    const map = installStorage();
    map.set("retenix:onboarding", JSON.stringify({ sid: "abc", email: "x" }));
    const { reportSessionStart } = await freshModule();
    reportSessionStart();
    const [payload] = sessionStarted.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(Object.keys(payload).sort()).toEqual(["onboardingSid", "sid"]);
  });
});
