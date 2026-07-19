import { describe, expect, it } from "vitest";
import {
  REDACTED,
  isDeniedKey,
  resolveRelease,
  scrubBreadcrumb,
  scrubEvent,
  scrubString,
  scrubValue,
} from "./observability";

// A real 65-byte secp256k1 signature (130 hex chars) and a real 32-byte tx
// hash (64 hex chars). The whole scrubbing design hinges on telling these two
// apart, so they are fixtures rather than inline literals.
const SIGNATURE = `0x${"a1b2".repeat(32)}${"cd".repeat(1)}`; // 130 hex chars
const TX_HASH = `0x${"9f".repeat(32)}`; // 64 hex chars

describe("resolveRelease", () => {
  it("prefers an explicit SENTRY_RELEASE over any platform SHA", () => {
    expect(
      resolveRelease({ SENTRY_RELEASE: "manual-1", VERCEL_GIT_COMMIT_SHA: "abc" }),
    ).toBe("manual-1");
  });

  it("reads each platform's own variable", () => {
    expect(resolveRelease({ VERCEL_GIT_COMMIT_SHA: "v1" })).toBe("v1");
    expect(resolveRelease({ RAILWAY_GIT_COMMIT_SHA: "r1" })).toBe("r1");
    expect(resolveRelease({ GITHUB_SHA: "g1" })).toBe("g1");
  });

  it("is undefined locally rather than inventing a release", () => {
    expect(resolveRelease({})).toBeUndefined();
    expect(resolveRelease({ VERCEL_GIT_COMMIT_SHA: "" })).toBeUndefined();
  });

  it("keeps the full 40-char SHA — Sentry needs it to associate commits", () => {
    const sha = "6ec34ef".padEnd(40, "0");
    expect(resolveRelease({ GITHUB_SHA: sha })).toBe(sha);
  });
});

describe("scrubString", () => {
  it("redacts a serialized signature / 7702 authorization tuple", () => {
    expect(scrubString(`sig=${SIGNATURE}`)).toBe(`sig=${REDACTED}`);
  });

  // The single most important assertion in this file. Doc 08's failure story is
  // "here is the execution row and here is the tx" — a scrubber that eats tx
  // hashes silently destroys every incident investigation.
  it("PRESERVES transaction hashes and rootHashes (64 hex) — doc 08 debugging", () => {
    expect(scrubString(`uaTxId=${TX_HASH}`)).toBe(`uaTxId=${TX_HASH}`);
    expect(scrubString(`rootHash ${TX_HASH} submitted`)).toContain(TX_HASH);
  });

  it("preserves EVM addresses — public by construction", () => {
    const addr = "0x606cDadeeb7FF1e3d86C92e34b2e24dC9E9C6024";
    expect(scrubString(`policy at ${addr}`)).toContain(addr);
  });

  it("redacts provider credentials by prefix", () => {
    for (const secret of [
      "sk_live_abcdefgh1234",
      "pk_live_abcdefgh1234",
      "sntrys_abcdefghijklmnop1234",
      "re_abcdefghijklmnop",
      "whsec_abcdefghijklmnop",
      "sk-ant-abcdefghijklmnop",
    ]) {
      expect(scrubString(`key=${secret}`), secret).toBe(`key=${REDACTED}`);
    }
  });

  it("redacts emails wherever they appear — doc 17: no emails, ever", () => {
    expect(scrubString("beneficiary sister@example.com enrolled")).toBe(
      `beneficiary ${REDACTED} enrolled`,
    );
  });

  it("redacts heir claim links — the token in the URL IS the credential", () => {
    expect(scrubString("sent https://retenix.app/claim/aB3dEf9xYz01 to heir")).toBe(
      `sent https://retenix.app${REDACTED} to heir`,
    );
  });
});

describe("isDeniedKey", () => {
  it("matches doc 14 escrow material under any casing convention", () => {
    for (const key of [
      "tuples_enc",
      "tuplesEnc",
      "escrowedTuples",
      "authorizationList",
      "beneficiary_email_enc",
      "beneficiaryEmail",
      "salt",
    ]) {
      expect(isDeniedKey(key), key).toBe(true);
    }
  });

  it("matches credentials and identity", () => {
    for (const key of [
      "privateKey",
      "AGENT_EOA_PRIVATE_KEY",
      "INTERNAL_API_TOKEN",
      "sessionSecret",
      "cookie",
      "email",
      "claimToken",
      "signature",
    ]) {
      expect(isDeniedKey(key), key).toBe(true);
    }
  });

  it("leaves the identifiers an incident actually needs", () => {
    for (const key of [
      "planId",
      "jobId",
      "executionId",
      "uaTxId",
      "userId",
      "chainId",
      "status",
      "attempt",
      "legUsd",
      "assetId",
      "reason",
    ]) {
      expect(isDeniedKey(key), key).toBe(false);
    }
  });
});

describe("scrubValue", () => {
  it("redacts by key name and keeps everything else", () => {
    expect(
      scrubValue({ planId: "p1", uaTxId: TX_HASH, tuplesEnc: "cipher", email: "a@b.co" }),
    ).toEqual({ planId: "p1", uaTxId: TX_HASH, tuplesEnc: REDACTED, email: REDACTED });
  });

  it("walks nested objects and arrays", () => {
    expect(
      scrubValue({ legs: [{ assetId: "spyx", signature: SIGNATURE }] }),
    ).toEqual({ legs: [{ assetId: "spyx", signature: REDACTED }] });
  });

  it("scrubs values even under an allowed key", () => {
    expect(scrubValue({ note: `signed ${SIGNATURE}` })).toEqual({
      note: `signed ${REDACTED}`,
    });
  });

  it("caps recursion rather than following a deep or cyclic structure", () => {
    const cyclic: Record<string, unknown> = { planId: "p1" };
    cyclic.self = cyclic;
    expect(() => scrubValue(cyclic)).not.toThrow();
  });

  it("passes non-objects through untouched", () => {
    expect(scrubValue(42)).toBe(42);
    expect(scrubValue(null)).toBeNull();
    expect(scrubValue(undefined)).toBeUndefined();
    expect(scrubValue(true)).toBe(true);
  });
});

describe("scrubBreadcrumb", () => {
  it("keeps a pipeline step legible while redacting its payload", () => {
    const out = scrubBreadcrumb({
      message: "step5:submitted",
      data: { planId: "p1", uaTxId: TX_HASH, rootSig: SIGNATURE },
    });
    expect(out.message).toBe("step5:submitted");
    expect(out.data).toEqual({ planId: "p1", uaTxId: TX_HASH, rootSig: REDACTED });
  });

  it("tolerates a crumb with neither message nor data", () => {
    expect(() => scrubBreadcrumb({})).not.toThrow();
  });
});

describe("scrubEvent", () => {
  it("reduces user to an opaque id — never email, username, or ip", () => {
    const out = scrubEvent({
      user: { id: "u1", email: "a@b.co", username: "ann", ip_address: "1.2.3.4" },
    });
    expect(out.user).toEqual({ id: "u1" });
  });

  it("empties user entirely when there is no id to keep", () => {
    expect(scrubEvent({ user: { email: "a@b.co" } }).user).toEqual({});
  });

  it("scrubs the request url and headers", () => {
    const out = scrubEvent({
      request: {
        url: "https://retenix.app/claim/aB3dEf9xYz01",
        headers: { authorization: "Bearer abc123", "x-request-id": "r1" },
      },
    });
    expect(out.request?.url).not.toContain("aB3dEf9xYz01");
    expect(out.request?.headers).toEqual({
      authorization: REDACTED,
      "x-request-id": "r1",
    });
  });

  it("scrubs exception values, where secrets get interpolated most often", () => {
    const out = scrubEvent({
      exception: { values: [{ value: `relay failed for sister@example.com` }] },
    });
    expect(out.exception?.values?.[0]?.value).toBe(`relay failed for ${REDACTED}`);
  });

  it("scrubs extra/contexts/tags", () => {
    const out = scrubEvent({
      extra: { tuplesEnc: "cipher" },
      contexts: { estate: { beneficiaryEmail: "a@b.co" } },
      tags: { planId: "p1" },
    });
    expect(out.extra).toEqual({ tuplesEnc: REDACTED });
    expect(out.contexts).toEqual({ estate: { beneficiaryEmail: REDACTED } });
    expect(out.tags).toEqual({ planId: "p1" });
  });

  it("never throws on an empty or unexpected event", () => {
    expect(() => scrubEvent({})).not.toThrow();
    expect(() => scrubEvent({ exception: { values: [] } })).not.toThrow();
  });
});
