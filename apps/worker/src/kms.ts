// Agent-EOA custody (doc 08; tech spec §2/§4). Production signs with an AWS
// KMS key (ECC_SECG_P256K1, sign-only) — the key is un-exfiltratable and
// every SignCommand is a CloudTrail audit line (TS-14.1's per-execution
// audit log). Dev falls back to AGENT_EOA_PRIVATE_KEY (Particle's documented
// example flow), which is FORBIDDEN in production and fenced below.
//
// One digest signer, three consumers:
//   - UaSigner.signRootHash   → EIP-191 digest of the rootHash bytes
//                               (≡ wallet.signMessageSync(getBytes(...)), G5)
//   - UaSigner.sign7702Auth   → ethers hashAuthorization(...) digest
//                               (≡ wallet.signingKey.sign(...), doc 03)
//   - KmsEthersSigner         → Transaction.unsignedHash for the policy
//                               contract's recordExecution/refundExecution
//
// KMS returns DER; Ethereum wants 65-byte r‖s‖v with low-s (EIP-2). The
// converters below are exact and fixture-tested against ethers SigningKey.

import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
} from "@aws-sdk/client-kms";
import {
  AbstractSigner,
  Signature,
  Transaction,
  Wallet,
  computeAddress,
  getBytes,
  hashAuthorization,
  hashMessage,
  hexlify,
  recoverAddress,
  toBeHex,
  type Provider,
  type TransactionLike,
  type TransactionRequest,
} from "ethers";
import { walletSigner, type UaSigner } from "@retenix/ua";

import { env } from "../env";

const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
);
const HALF_N = SECP256K1_N >> 1n;

// ---------------------------------------------------------------------------
// Minimal DER parsing — KMS secp256k1 payloads are tiny (SPKI 88 bytes,
// ECDSA-Sig-Value ≤ 72), so short-form lengths are structural; long form
// means corruption and is rejected loudly.
// ---------------------------------------------------------------------------

function readDerLength(buf: Uint8Array, at: number): { len: number; next: number } {
  const b = buf[at];
  if (b === undefined) throw new Error("KMS DER: truncated length");
  if (b >= 0x80) throw new Error("KMS DER: unexpected long-form length");
  return { len: b, next: at + 1 };
}

/** ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER } */
export function derSignatureToRs(der: Uint8Array): { r: bigint; s: bigint } {
  let at = 0;
  if (der[at++] !== 0x30) throw new Error("KMS DER: signature is not a SEQUENCE");
  at = readDerLength(der, at).next;
  const readInt = (): bigint => {
    if (der[at++] !== 0x02) throw new Error("KMS DER: expected INTEGER");
    const { len, next } = readDerLength(der, at);
    at = next;
    const bytes = der.slice(at, at + len);
    if (bytes.length !== len || len === 0) throw new Error("KMS DER: truncated INTEGER");
    at += len;
    return BigInt(hexlify(bytes));
  };
  const r = readInt();
  const s = readInt();
  return { r, s };
}

/** SubjectPublicKeyInfo → 0x04‖X‖Y uncompressed point (65 bytes, hex). */
export function spkiToUncompressedPublicKey(spki: Uint8Array): string {
  let at = 0;
  if (spki[at++] !== 0x30) throw new Error("KMS DER: SPKI is not a SEQUENCE");
  at = readDerLength(spki, at).next;
  if (spki[at++] !== 0x30) throw new Error("KMS DER: expected AlgorithmIdentifier");
  const alg = readDerLength(spki, at);
  at = alg.next + alg.len;
  if (spki[at++] !== 0x03) throw new Error("KMS DER: expected BIT STRING");
  const bits = readDerLength(spki, at);
  at = bits.next;
  if (spki[at++] !== 0x00) throw new Error("KMS DER: unexpected unused bits");
  const point = spki.slice(at, at + bits.len - 1);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error("KMS key is not an uncompressed secp256k1 point");
  }
  return hexlify(point);
}

/** Low-s normalize (EIP-2) and recover v by trial against the known
 *  address — KMS gives no recovery id, and flipping s flips the parity. */
export function toEthereumSignature(
  digest: string,
  r: bigint,
  s: bigint,
  address: string,
): Signature {
  const lowS = s > HALF_N ? SECP256K1_N - s : s;
  const rHex = toBeHex(r, 32);
  const sHex = toBeHex(lowS, 32);
  for (const v of [27, 28]) {
    const candidate = Signature.from({ r: rHex, s: sHex, v });
    if (recoverAddress(digest, candidate).toLowerCase() === address.toLowerCase()) {
      return candidate;
    }
  }
  throw new Error("KMS signature does not recover to the agent address");
}

// ---------------------------------------------------------------------------
// KmsKey — the one KMS touchpoint (injectable client for tests)
// ---------------------------------------------------------------------------

/** Structural client so tests inject a local signer; KMSClient satisfies it. */
export interface KmsClientLike {
  send(command: GetPublicKeyCommand): Promise<{ PublicKey?: Uint8Array }>;
  send(command: SignCommand): Promise<{ Signature?: Uint8Array }>;
}

export class KmsKey {
  private cachedAddress?: string;

  constructor(
    private readonly client: KmsClientLike,
    private readonly keyId: string,
  ) {}

  async address(): Promise<string> {
    if (!this.cachedAddress) {
      const out = await this.client.send(new GetPublicKeyCommand({ KeyId: this.keyId }));
      if (!out.PublicKey) throw new Error("KMS GetPublicKey returned no key material");
      this.cachedAddress = computeAddress(spkiToUncompressedPublicKey(out.PublicKey));
    }
    return this.cachedAddress;
  }

  /** Sign a 32-byte digest. Every call lands in CloudTrail (TS-14.1). */
  async signDigest(digest: string): Promise<Signature> {
    const address = await this.address();
    const out = await this.client.send(
      new SignCommand({
        KeyId: this.keyId,
        Message: getBytes(digest),
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      }),
    );
    if (!out.Signature) throw new Error("KMS Sign returned no signature");
    const { r, s } = derSignatureToRs(out.Signature);
    return toEthereumSignature(digest, r, s, address);
  }
}

// ---------------------------------------------------------------------------
// The two signer faces
// ---------------------------------------------------------------------------

/** Doc 03's UaSigner over KMS — must produce the identical digest
 *  signatures walletSigner produces (G5; proven byte-equal in tests). */
export function kmsUaSigner(kms: KmsKey): UaSigner {
  return {
    async signRootHash(rootHash: string): Promise<string> {
      const sig = await kms.signDigest(hashMessage(getBytes(rootHash)));
      return sig.serialized;
    },
    async sign7702Auth(auth: {
      chainId: number;
      nonce: number;
      address: string;
    }): Promise<string> {
      const sig = await kms.signDigest(hashAuthorization(auth));
      return sig.serialized;
    },
  };
}

/** Ethers signer over KMS for the policy-contract transactions. */
export class KmsEthersSigner extends AbstractSigner {
  constructor(
    private readonly kms: KmsKey,
    provider?: Provider | null,
  ) {
    super(provider);
  }

  getAddress(): Promise<string> {
    return this.kms.address();
  }

  connect(provider: Provider | null): KmsEthersSigner {
    return new KmsEthersSigner(this.kms, provider);
  }

  async signTransaction(tx: TransactionRequest): Promise<string> {
    const { from, ...rest } = tx;
    if (from) {
      const self = await this.getAddress();
      if (String(from).toLowerCase() !== self.toLowerCase()) {
        throw new Error(`KmsEthersSigner: cannot sign for ${String(from)}`);
      }
    }
    const btx = Transaction.from(rest as TransactionLike<string>);
    btx.signature = await this.kms.signDigest(btx.unsignedHash);
    return btx.serialized;
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    return (await this.kms.signDigest(hashMessage(message))).serialized;
  }

  signTypedData(): Promise<string> {
    return Promise.reject(
      new Error("KmsEthersSigner: typed data is not part of the agent surface"),
    );
  }
}

// ---------------------------------------------------------------------------
// Agent signer resolution (dev wallet ⇄ KMS)
// ---------------------------------------------------------------------------

export interface AgentSigner {
  kind: "dev-wallet" | "kms";
  address: string;
  uaSigner: UaSigner;
  /** Unconnected; callers `.connect(provider)` per chain. */
  ethSigner: Wallet | KmsEthersSigner;
}

export async function getAgentSigner(): Promise<AgentSigner> {
  if (env.AGENT_EOA_PRIVATE_KEY) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "AGENT_EOA_PRIVATE_KEY is dev-only and forbidden in production — unset it; the agent key lives in AWS KMS (doc 00/08)",
      );
    }
    const wallet = new Wallet(env.AGENT_EOA_PRIVATE_KEY);
    console.warn(
      `[worker] agent signer: DEV wallet ${wallet.address} from AGENT_EOA_PRIVATE_KEY — production uses KMS`,
    );
    return {
      kind: "dev-wallet",
      address: wallet.address,
      uaSigner: walletSigner(wallet),
      ethSigner: wallet,
    };
  }

  const client = new KMSClient({ region: env.AWS_REGION }) as unknown as KmsClientLike;
  const kms = new KmsKey(client, env.KMS_AGENT_KEY_ID);
  const address = await kms.address(); // proves connectivity at boot; CloudTrail line
  console.log(`[worker] agent signer: AWS KMS ${address} (key ${env.KMS_AGENT_KEY_ID})`);
  return {
    kind: "kms",
    address,
    uaSigner: kmsUaSigner(kms),
    ethSigner: new KmsEthersSigner(kms),
  };
}
