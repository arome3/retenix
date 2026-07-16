import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import {
  SigningKey,
  Transaction,
  Wallet,
  computeAddress,
  getBytes,
  hashAuthorization,
  hashMessage,
  hexlify,
  keccak256,
  recoverAddress,
  toUtf8Bytes,
  verifyMessage,
} from "ethers";
import { describe, expect, it } from "vitest";
import { walletSigner } from "@retenix/ua";

import {
  KmsEthersSigner,
  KmsKey,
  derSignatureToRs,
  kmsUaSigner,
  spkiToUncompressedPublicKey,
  toEthereumSignature,
  type KmsClientLike,
} from "./kms";

// Well-known anvil test key #0 — ground truth via ethers SigningKey. The
// mock "KMS" signs with this key and hands back DER, so every conversion is
// checked against a real ECDSA implementation, not synthetic bytes.
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const signingKey = new SigningKey(PK);
const wallet = new Wallet(PK);
const ADDRESS = wallet.address;

const N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
);

// secp256k1 SubjectPublicKeyInfo prefix (RFC 5480): SEQUENCE(86) {
//   SEQUENCE(16) { OID ecPublicKey, OID secp256k1 }, BIT STRING(66) { 00, point } }
const SPKI_PREFIX = "0x3056301006072a8648ce3d020106052b8104000a034200";
// Prefix + the full uncompressed point (0x04‖X‖Y) — strip only the "0x".
const spkiBytes = getBytes(SPKI_PREFIX + signingKey.publicKey.slice(2));

// --- DER encoders (test-side, independent of the parser under test) --------

function derInt(x: bigint): number[] {
  let hex = x.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = [...getBytes(`0x${hex}`)];
  if (bytes[0] & 0x80) bytes = [0, ...bytes]; // INTEGER sign padding
  return [0x02, bytes.length, ...bytes];
}

function derSig(r: bigint, s: bigint): Uint8Array {
  const body = [...derInt(r), ...derInt(s)];
  return new Uint8Array([0x30, body.length, ...body]);
}

function mockKms(opts: { forceHighS?: boolean } = {}): {
  client: KmsClientLike;
  calls: { getPublicKey: number; sign: number };
} {
  const calls = { getPublicKey: 0, sign: 0 };
  const client = {
    send(cmd: GetPublicKeyCommand | SignCommand) {
      if (cmd instanceof GetPublicKeyCommand) {
        calls.getPublicKey += 1;
        return Promise.resolve({ PublicKey: spkiBytes });
      }
      calls.sign += 1;
      const digest = hexlify((cmd as SignCommand).input.Message as Uint8Array);
      const sig = signingKey.sign(digest); // ethers emits low-s
      const r = BigInt(sig.r);
      let s = BigInt(sig.s);
      if (opts.forceHighS) s = N - s; // what raw KMS is allowed to return
      return Promise.resolve({ Signature: derSig(r, s) });
    },
  } as KmsClientLike;
  return { client, calls };
}

const DIGEST = keccak256(toUtf8Bytes("retenix kms fixture digest"));

// ---------------------------------------------------------------------------

describe("SPKI → address", () => {
  it("parses the uncompressed point and derives the key's address", () => {
    const point = spkiToUncompressedPublicKey(spkiBytes);
    expect(point).toBe(signingKey.publicKey);
    expect(computeAddress(point)).toBe(ADDRESS);
  });

  it("rejects a compressed point", () => {
    const compressed = SigningKey.computePublicKey(PK, true); // 33 bytes
    const bad = getBytes(
      "0x3036301006072a8648ce3d020106052b8104000a032200" + compressed.slice(2),
    );
    expect(() => spkiToUncompressedPublicKey(bad)).toThrow(/uncompressed/);
  });
});

describe("DER signature → r/s", () => {
  it("round-trips a real signature, including sign-bit padding", () => {
    const sig = signingKey.sign(DIGEST);
    const parsed = derSignatureToRs(derSig(BigInt(sig.r), BigInt(sig.s)));
    expect(parsed.r).toBe(BigInt(sig.r));
    expect(parsed.s).toBe(BigInt(sig.s));
    // Explicit high-bit vector: DER must carry (and we must strip) the 0x00 pad.
    const highBit = (1n << 255n) + 7n;
    expect(derSignatureToRs(derSig(highBit, 3n))).toEqual({ r: highBit, s: 3n });
  });

  it("rejects structurally broken DER", () => {
    expect(() => derSignatureToRs(new Uint8Array([0x02, 0x01, 0x01]))).toThrow(
      /SEQUENCE/,
    );
    const sig = signingKey.sign(DIGEST);
    const truncated = derSig(BigInt(sig.r), BigInt(sig.s)).slice(0, 10);
    expect(() => derSignatureToRs(truncated)).toThrow(/DER/);
  });
});

describe("low-s normalization + recovery id", () => {
  it("normalizes a high-s signature back to the canonical low-s form", () => {
    const truth = signingKey.sign(DIGEST); // low-s ground truth
    const highS = N - BigInt(truth.s);
    const restored = toEthereumSignature(DIGEST, BigInt(truth.r), highS, ADDRESS);
    expect(restored.s).toBe(truth.s);
    expect(restored.r).toBe(truth.r);
    expect(recoverAddress(DIGEST, restored)).toBe(ADDRESS);
    // And the untouched low-s path reproduces the ground truth exactly.
    const direct = toEthereumSignature(DIGEST, BigInt(truth.r), BigInt(truth.s), ADDRESS);
    expect(direct.serialized).toBe(truth.serialized);
  });

  it("refuses a signature that recovers to a different key", () => {
    const other = new SigningKey(keccak256(toUtf8Bytes("other key")));
    const sig = other.sign(DIGEST);
    expect(() =>
      toEthereumSignature(DIGEST, BigInt(sig.r), BigInt(sig.s), ADDRESS),
    ).toThrow(/does not recover/);
  });
});

describe("KmsKey", () => {
  it("derives and caches the address (one GetPublicKey)", async () => {
    const { client, calls } = mockKms();
    const kms = new KmsKey(client, "key-id");
    expect(await kms.address()).toBe(ADDRESS);
    expect(await kms.address()).toBe(ADDRESS);
    expect(calls.getPublicKey).toBe(1);
  });

  it("signDigest returns a verifying signature even when KMS hands back high-s", async () => {
    const { client } = mockKms({ forceHighS: true });
    const kms = new KmsKey(client, "key-id");
    const sig = await kms.signDigest(DIGEST);
    expect(recoverAddress(DIGEST, sig)).toBe(ADDRESS);
    expect(BigInt(sig.s) <= N >> 1n).toBe(true);
  });
});

describe("kmsUaSigner ≡ walletSigner (G5 — identical digest signatures)", () => {
  const rootHash = keccak256(toUtf8Bytes("ua root hash"));
  const auth = {
    chainId: 42161,
    nonce: 7,
    address: "0x606cDadeeb7FF1e3d86C92e34b2e24dC9E9C6024",
  };

  it("signRootHash is byte-identical to signMessageSync(getBytes(rootHash))", async () => {
    for (const forceHighS of [false, true]) {
      const kmsSig = await kmsUaSigner(
        new KmsKey(mockKms({ forceHighS }).client, "k"),
      ).signRootHash(rootHash);
      const walletSig = await walletSigner(wallet).signRootHash(rootHash);
      expect(kmsSig).toBe(walletSig); // RFC 6979 + low-s ⇒ byte equality
      expect(verifyMessage(getBytes(rootHash), kmsSig)).toBe(ADDRESS);
    }
  });

  it("sign7702Auth is byte-identical to signingKey.sign(hashAuthorization(...))", async () => {
    const kmsSig = await kmsUaSigner(
      new KmsKey(mockKms({ forceHighS: true }).client, "k"),
    ).sign7702Auth(auth);
    const walletSig = await walletSigner(wallet).sign7702Auth(auth);
    expect(kmsSig).toBe(walletSig);
    expect(recoverAddress(hashAuthorization(auth), kmsSig)).toBe(ADDRESS);
  });
});

describe("KmsEthersSigner", () => {
  const txFields = {
    type: 2,
    chainId: 42161,
    nonce: 5,
    gasLimit: 120_000n,
    maxFeePerGas: 100_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    to: "0x606cDadeeb7FF1e3d86C92e34b2e24dC9E9C6024",
    value: 0n,
    data: "0xdeadbeef",
  };

  it("signs an EIP-1559 tx identically to an ethers Wallet", async () => {
    const signer = new KmsEthersSigner(new KmsKey(mockKms().client, "k"));
    const ours = await signer.signTransaction(txFields);
    const theirs = await wallet.signTransaction(txFields);
    expect(ours).toBe(theirs);
    expect(Transaction.from(ours).from).toBe(ADDRESS);
  });

  it("refuses to sign for a foreign from-address", async () => {
    const signer = new KmsEthersSigner(new KmsKey(mockKms().client, "k"));
    await expect(
      signer.signTransaction({
        ...txFields,
        from: "0x0000000000000000000000000000000000000001",
      }),
    ).rejects.toThrow(/cannot sign for/);
  });

  it("signMessage matches the wallet; typed data is fenced off", async () => {
    const signer = new KmsEthersSigner(new KmsKey(mockKms().client, "k"));
    expect(await signer.signMessage("audit line")).toBe(
      await wallet.signMessage("audit line"),
    );
    await expect(signer.signTypedData()).rejects.toThrow(/typed data/);
  });
});

describe("EIP-191 digest discipline (G5)", () => {
  it("rootHash signing uses hashMessage over the BYTES, not the hex string", () => {
    const rootHash = keccak256(toUtf8Bytes("x"));
    expect(hashMessage(getBytes(rootHash))).not.toBe(hashMessage(rootHash));
  });
});
