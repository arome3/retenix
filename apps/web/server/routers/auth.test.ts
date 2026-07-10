import { getDb, users } from "@retenix/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashEmail } from "@/lib/emailHash";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import type { Context } from "../context";

// The one module that touches MAGIC_SECRET_KEY, so the one module to mock.
const token = {
  validate: vi.fn<(t: string, a?: string) => void>(),
  getIssuer: vi.fn<(t: string) => string>(),
};
const usersModule = {
  getMetadataByToken: vi.fn(),
};
vi.mock("../magic-admin", () => ({
  getMagicAdmin: async () => ({ token, users: usersModule }),
}));

const { appRouter } = await import("./index");

const EMAIL = "ada@example.com";
const ISSUER = "did:ethr:0x1234567890AbcdEF1234567890aBcdef12345678";
// Lowercase on the wire; the router must store one canonical casing.
const ADDRESS_LOWER = "0x1234567890abcdef1234567890abcdef12345678";
const ADDRESS_CHECKSUM = "0x1234567890AbcdEF1234567890aBcdef12345678";

const db = getDb();

function makeCtx(): Context & { resHeaders: Headers } {
  return {
    db,
    session: null,
    headers: new Headers(),
    resHeaders: new Headers(),
  };
}

function happyPath() {
  token.validate.mockReturnValue(undefined);
  token.getIssuer.mockReturnValue(ISSUER);
  usersModule.getMetadataByToken.mockResolvedValue({
    issuer: ISSUER,
    email: EMAIL,
    publicAddress: ADDRESS_LOWER,
    oauthProvider: null,
    phoneNumber: null,
    username: null,
    wallets: null,
  });
}

async function cleanup() {
  await db.delete(users).where(eq(users.emailHash, hashEmail(EMAIL)));
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanup();
});
afterAll(cleanup);

describe("auth.magicCallback — DID validation failure paths", () => {
  it("rejects a malformed token (validate throws) with UNAUTHORIZED", async () => {
    token.validate.mockImplementation(() => {
      throw new Error("ERROR_MALFORMED_TOKEN");
    });
    const caller = appRouter.createCaller(makeCtx());
    await expect(
      caller.auth.magicCallback({ didToken: "not-a-did-token" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects an expired token with UNAUTHORIZED", async () => {
    token.validate.mockImplementation(() => {
      throw new Error("ERROR_DIDT_EXPIRED");
    });
    const caller = appRouter.createCaller(makeCtx());
    await expect(
      caller.auth.magicCallback({ didToken: "expired" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a token whose issuer disagrees with its metadata", async () => {
    happyPath();
    token.getIssuer.mockReturnValue("did:ethr:0x000000000000000000000000000000000000dEaD");
    const caller = appRouter.createCaller(makeCtx());
    await expect(
      caller.auth.magicCallback({ didToken: "wrong-issuer" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects metadata with no email or no address", async () => {
    happyPath();
    usersModule.getMetadataByToken.mockResolvedValue({
      issuer: ISSUER,
      email: null,
      publicAddress: ADDRESS_LOWER,
    });
    const caller = appRouter.createCaller(makeCtx());
    await expect(caller.auth.magicCallback({ didToken: "t" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    usersModule.getMetadataByToken.mockResolvedValue({
      issuer: ISSUER,
      email: EMAIL,
      publicAddress: null,
    });
    await expect(caller.auth.magicCallback({ didToken: "t" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects an address that is not an address", async () => {
    happyPath();
    usersModule.getMetadataByToken.mockResolvedValue({
      issuer: ISSUER,
      email: EMAIL,
      publicAddress: "0xnot-an-address",
    });
    const caller = appRouter.createCaller(makeCtx());
    await expect(caller.auth.magicCallback({ didToken: "t" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("never issues a cookie on a failure path — no partial session", async () => {
    token.validate.mockImplementation(() => {
      throw new Error("ERROR_MALFORMED_TOKEN");
    });
    const ctx = makeCtx();
    await expect(
      appRouter.createCaller(ctx).auth.magicCallback({ didToken: "bad" }),
    ).rejects.toThrow();
    expect(ctx.resHeaders.get("set-cookie")).toBeNull();
  });
});

describe("auth.magicCallback — success path (integration, real Postgres)", () => {
  it("upserts the user row with email_hash and never the raw email", async () => {
    happyPath();
    const ctx = makeCtx();
    const result = await appRouter.createCaller(ctx).auth.magicCallback({
      didToken: "valid",
    });

    expect(result).toEqual({ eoa: ADDRESS_CHECKSUM, region: "" });

    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.emailHash, hashEmail(EMAIL)));

    expect(row.emailHash).toBe(hashEmail(EMAIL));
    expect(row.eoaAddr).toBe(ADDRESS_CHECKSUM);
    // ua_* filled by doc 03; region by doc 04. Absence is the gate.
    expect(row.uaEvmAddr).toBe("");
    expect(row.uaSolAddr).toBe("");
    expect(row.region).toBe("");

    // PII minimization (TS-12.2): no column may carry the address the user typed.
    const serialized = JSON.stringify(row).toLowerCase();
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain("ada");
  });

  it("issues a signed session cookie carrying { userId, eoa, issuer, region }", async () => {
    happyPath();
    const ctx = makeCtx();
    await appRouter.createCaller(ctx).auth.magicCallback({ didToken: "valid" });

    const setCookie = ctx.resHeaders.getSetCookie();
    const session = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(session).toBeDefined();
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");

    const value = decodeURIComponent(session!.split(";")[0].split("=")[1]);
    const verified = await verifySession(value);
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.emailHash, hashEmail(EMAIL)));

    expect(verified).toMatchObject({
      userId: row.id,
      eoa: ADDRESS_CHECKSUM,
      issuer: ISSUER,
      region: "",
    });
  });

  it("is idempotent: a second login reuses the same row", async () => {
    happyPath();
    await appRouter.createCaller(makeCtx()).auth.magicCallback({ didToken: "valid" });
    await appRouter.createCaller(makeCtx()).auth.magicCallback({ didToken: "valid" });

    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.emailHash, hashEmail(EMAIL)));
    expect(rows).toHaveLength(1);
  });
});

describe("auth.logout", () => {
  it("expires both cookies", async () => {
    const ctx = makeCtx();
    await appRouter.createCaller(ctx).auth.logout();
    const cleared = ctx.resHeaders.getSetCookie();
    expect(cleared).toHaveLength(2);
    for (const c of cleared) expect(c).toContain("Max-Age=0");
  });
});
