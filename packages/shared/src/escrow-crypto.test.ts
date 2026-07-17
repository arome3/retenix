import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  devEscrowProvider,
  encryptEnvelope,
  escrowEncryptionContext,
  parseEnvelope,
  type EscrowContext,
  type EscrowKeyProvider,
} from "./escrow-crypto";

const OWNER = "0x8FdfCbCc3FB3d5Cf971685Fd44a36F7e363d456D";
const CTX: EscrowContext = { owner: OWNER, purpose: "estate-tuples" };

describe("escrow envelope (doc 14, TS-14.3)", () => {
  const provider = devEscrowProvider("dev-secret-for-tests");

  it("round-trips utf8 and binary plaintexts", async () => {
    const blob = await encryptEnvelope(provider, CTX, '{"tuples":[1,2,3]}');
    expect(JSON.parse(blob).kind).toBe("dev");
    const out = await decryptEnvelope(provider, CTX, blob);
    expect(out.toString("utf8")).toBe('{"tuples":[1,2,3]}');

    const bin = new Uint8Array([0, 255, 7, 128]);
    const blob2 = await encryptEnvelope(provider, CTX, bin);
    expect(new Uint8Array(await decryptEnvelope(provider, CTX, blob2))).toEqual(bin);
  });

  it("fresh DEK and IV per write — same plaintext, different ciphertext", async () => {
    const a = parseEnvelope(await encryptEnvelope(provider, CTX, "same"));
    const b = parseEnvelope(await encryptEnvelope(provider, CTX, "same"));
    expect(a.ct).not.toBe(b.ct);
    expect(a.encKey).not.toBe(b.encKey);
    expect(a.iv).not.toBe(b.iv);
  });

  it("refuses decryption under a different owner (AAD + context binding)", async () => {
    const blob = await encryptEnvelope(provider, CTX, "secret");
    const other: EscrowContext = { ...CTX, owner: "0x0000000000000000000000000000000000000001" };
    await expect(decryptEnvelope(provider, other, blob)).rejects.toThrow();
  });

  it("refuses decryption under a different purpose", async () => {
    const blob = await encryptEnvelope(provider, CTX, "secret");
    await expect(
      decryptEnvelope(provider, { ...CTX, purpose: "estate-beneficiary" }, blob),
    ).rejects.toThrow();
  });

  it("owner case is normalized — mixed-case context still decrypts", async () => {
    const blob = await encryptEnvelope(provider, CTX, "secret");
    const lower: EscrowContext = { owner: OWNER.toLowerCase(), purpose: "estate-tuples" };
    expect((await decryptEnvelope(provider, lower, blob)).toString("utf8")).toBe("secret");
  });

  it("refuses a tampered ciphertext / tag", async () => {
    const blob = await encryptEnvelope(provider, CTX, "secret");
    const env = JSON.parse(blob);
    const ct = Buffer.from(env.ct, "base64");
    ct[0] ^= 0xff;
    env.ct = ct.toString("base64");
    await expect(decryptEnvelope(provider, CTX, JSON.stringify(env))).rejects.toThrow();
  });

  it("kind mismatch is a loud error (kms blob to a dev provider and back)", async () => {
    const blob = await encryptEnvelope(provider, CTX, "secret");
    const asKms = JSON.stringify({ ...JSON.parse(blob), kind: "kms" });
    await expect(decryptEnvelope(provider, CTX, asKms)).rejects.toThrow(/kind "kms"/);
  });

  it("a different dev secret cannot unwrap the DEK", async () => {
    const blob = await encryptEnvelope(provider, CTX, "secret");
    const other = devEscrowProvider("a-completely-different-secret");
    await expect(decryptEnvelope(other, CTX, blob)).rejects.toThrow();
  });

  it("parseEnvelope rejects malformed blobs", () => {
    expect(() => parseEnvelope("not json")).toThrow();
    expect(() => parseEnvelope('{"v":2,"kind":"dev","encKey":"a","iv":"a","tag":"a","ct":""}')).toThrow();
  });

  it("escrowEncryptionContext lowercases the owner (CloudTrail-stable)", () => {
    expect(escrowEncryptionContext(CTX)).toEqual({
      app: "retenix",
      purpose: "estate-tuples",
      owner: OWNER.toLowerCase(),
    });
  });

  it("works with a KMS-shaped provider (structural, no AWS)", async () => {
    // a fake "KMS": wraps the DEK by XOR with a fixed pad — enough to prove
    // the envelope layer treats the provider as opaque
    const pad = Buffer.alloc(32, 0x5a);
    const xor = (bytes: Buffer): Buffer => {
      const out = Buffer.alloc(bytes.length);
      for (let i = 0; i < bytes.length; i++) out[i] = bytes[i]! ^ pad[i % pad.length]!;
      return out;
    };
    const fakeKms: EscrowKeyProvider = {
      kind: "kms",
      generateDataKey: () => {
        const dek = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 1));
        return Promise.resolve({ plaintextKey: Buffer.from(dek), encryptedKey: xor(dek) });
      },
      decryptDataKey: (enc) => Promise.resolve(xor(enc)),
    };
    const blob = await encryptEnvelope(fakeKms, CTX, "via kms shape");
    expect(parseEnvelope(blob).kind).toBe("kms");
    expect((await decryptEnvelope(fakeKms, CTX, blob)).toString("utf8")).toBe("via kms shape");
  });
});
