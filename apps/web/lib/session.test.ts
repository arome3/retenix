import { describe, expect, it } from "vitest";
import { parseCookieHeader, serializeCookie } from "./cookies";
import { hashEmail } from "./emailHash";
import {
  GATE_COOKIE,
  SESSION_COOKIE,
  SESSION_REFRESH_AFTER_SECS,
  SESSION_TTL_SECS,
  clearedSetCookies,
  sessionSetCookies,
  shouldRefresh,
  signSession,
  verifySession,
  type SessionPayload,
} from "./session";

const PAYLOAD: SessionPayload = {
  userId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  eoa: "0x1234567890AbcdEF1234567890aBcdef12345678",
  issuer: "did:ethr:0x1234567890AbcdEF1234567890aBcdef12345678",
  region: "",
};

describe("session cookie signing", () => {
  it("round-trips the documented payload", async () => {
    const verified = await verifySession(await signSession(PAYLOAD));
    expect(verified).toMatchObject({
      userId: PAYLOAD.userId,
      eoa: PAYLOAD.eoa,
      issuer: PAYLOAD.issuer,
      region: "",
    });
    expect(verified?.issuedAt).toBeTypeOf("number");
  });

  it("rejects a tampered payload", async () => {
    const token = await signSession(PAYLOAD);
    const [header, body, sig] = token.split(".");
    const forged = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    forged.eoa = "0x000000000000000000000000000000000000dEaD";
    const tampered = [
      header,
      Buffer.from(JSON.stringify(forged)).toString("base64url"),
      sig,
    ].join(".");
    expect(await verifySession(tampered)).toBeNull();
  });

  it("rejects garbage, an empty token, and an absent cookie", async () => {
    expect(await verifySession(undefined)).toBeNull();
    expect(await verifySession("")).toBeNull();
    expect(await verifySession("not.a.jwt")).toBeNull();
  });

  it("rejects an expired token", async () => {
    // jose validates exp against the wall clock; sign one that is already stale.
    const { SignJWT } = await import("jose");
    const key = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("session-secret-test"),
      ),
    );
    const stale = await new SignJWT({ eoa: PAYLOAD.eoa, issuer: PAYLOAD.issuer, region: "" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(PAYLOAD.userId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 60)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 30)
      .sign(key);
    expect(await verifySession(stale)).toBeNull();
  });

  it("rejects a token signed with the wrong secret", async () => {
    const { SignJWT } = await import("jose");
    const wrongKey = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("not-the-secret")),
    );
    const token = await new SignJWT({ eoa: PAYLOAD.eoa, issuer: PAYLOAD.issuer, region: "" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(PAYLOAD.userId)
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(wrongKey);
    expect(await verifySession(token)).toBeNull();
  });

  it("refuses to slide before a day has passed, and slides after", () => {
    const now = Date.now();
    const issuedAt = Math.floor(now / 1000);
    expect(shouldRefresh(issuedAt, now)).toBe(false);
    expect(shouldRefresh(issuedAt - SESSION_REFRESH_AFTER_SECS, now)).toBe(false);
    expect(shouldRefresh(issuedAt - SESSION_REFRESH_AFTER_SECS - 1, now)).toBe(true);
  });
});

describe("session cookie flags (doc 02 hard constraint)", () => {
  it("sets httpOnly, Secure, SameSite=Lax on the session cookie", () => {
    const [session] = sessionSetCookies("token-value", "");
    expect(session).toContain(`${SESSION_COOKIE}=token-value`);
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");
    expect(session).toContain("Path=/");
    expect(session).toContain(`Max-Age=${SESSION_TTL_SECS}`);
  });

  it("expires the gate hint while region is unset, and sets it once region lands", () => {
    const [, gateUnset] = sessionSetCookies("t", "");
    expect(gateUnset).toContain(`${GATE_COOKIE}=;`);
    expect(gateUnset).toContain("Max-Age=0");

    const [, gateSet] = sessionSetCookies("t", "US");
    expect(gateSet).toContain(`${GATE_COOKIE}=1`);
    expect(gateSet).toContain(`Max-Age=${SESSION_TTL_SECS}`);
    expect(gateSet).toContain("HttpOnly");
  });

  it("logout expires both cookies", () => {
    const cleared = clearedSetCookies();
    expect(cleared).toHaveLength(2);
    for (const c of cleared) expect(c).toContain("Max-Age=0");
    expect(cleared[0]).toContain(SESSION_COOKIE);
    expect(cleared[1]).toContain(GATE_COOKIE);
  });
});

describe("cookie header parsing", () => {
  it("reads a header the app itself wrote", () => {
    const header = sessionSetCookies("abc.def.ghi", "US")
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(parseCookieHeader(header)).toEqual({
      [SESSION_COOKIE]: "abc.def.ghi",
      [GATE_COOKIE]: "1",
    });
  });

  it("survives an absent header, junk segments, and a malformed escape", () => {
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader("=novalue; noequals; a=1")).toEqual({ a: "1" });
    expect(parseCookieHeader("bad=%E0%A4%A; ok=2")).toEqual({ ok: "2" });
  });

  it("keeps the first occurrence of a duplicated name", () => {
    expect(parseCookieHeader("a=first; a=second")).toEqual({ a: "first" });
  });

  it("percent-encodes values it writes", () => {
    expect(serializeCookie("n", "a b;c", { maxAge: 1 })).toContain("n=a%20b%3Bc");
  });
});

describe("hashEmail", () => {
  it("hashes the lowercased, trimmed address", async () => {
    expect(hashEmail("  Ada@Example.COM ")).toBe(hashEmail("ada@example.com"));
  });

  it("produces a 32-byte hex digest that contains no trace of the email", () => {
    const digest = hashEmail("ada@example.com");
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(digest).not.toContain("ada");
  });

  it("separates distinct addresses", () => {
    expect(hashEmail("ada@example.com")).not.toBe(hashEmail("bob@example.com"));
  });
});
