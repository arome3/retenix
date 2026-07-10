import {
  getBytes,
  hashAuthorization,
  Signature,
  verifyAuthorization,
  verifyMessage,
  Wallet,
} from "ethers";
import { describe, expect, it } from "vitest";
import {
  magicSigner,
  walletSigner,
  type MagicSignerClient,
} from "./signers";

// A throwaway test key (Anvil/Hardhat account #1) — no funds, unit tests only.
const PK =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const wallet = new Wallet(PK);
const ROOT_HASH = `0x${"ab".repeat(32)}`;

describe("walletSigner (backend flow)", () => {
  it("signRootHash = signMessageSync(getBytes(rootHash)) and recovers the EOA", async () => {
    const sig = await walletSigner(wallet).signRootHash(ROOT_HASH);
    // Matches the documented backend one-liner exactly (G5: EIP-191, not typed data).
    expect(sig).toBe(wallet.signMessageSync(getBytes(ROOT_HASH)));
    // Independent recovery: the personal-message signature is by the wallet's key.
    expect(verifyMessage(getBytes(ROOT_HASH), sig)).toBe(wallet.address);
  });

  it("sign7702Auth serializes signingKey.sign(hashAuthorization(...)) and verifies", async () => {
    const auth = { chainId: 42161, nonce: 0, address: wallet.address };
    const serialized = await walletSigner(wallet).sign7702Auth(auth);
    // Matches the official Particle example's one-liner.
    expect(serialized).toBe(
      wallet.signingKey.sign(hashAuthorization(auth)).serialized,
    );
    // Independent verification (mirrors Gate G1): recovers the signer over the tuple.
    expect(verifyAuthorization(auth, serialized)).toBe(wallet.address);
  });
});

describe("magicSigner (browser flow)", () => {
  /** A fake Magic client that records call order and returns a real {v,r,s}. */
  function fakeMagic(raw: { v: number; r: string; s: string }) {
    const calls: string[] = [];
    let personalSignArgs: { method: string; params: unknown[] } | undefined;
    const magic: MagicSignerClient = {
      evm: {
        switchChain(id) {
          calls.push(`switchChain:${id}`);
          return Promise.resolve();
        },
      },
      wallet: {
        sign7702Authorization(a) {
          calls.push(`sign7702:${a.chainId}:${a.nonce}`);
          return Promise.resolve(raw);
        },
      },
      rpcProvider: {
        request(args) {
          personalSignArgs = args;
          calls.push(`request:${args.method}`);
          return Promise.resolve("0xPERSONALSIG");
        },
      },
    };
    return { magic, calls, personalSignArgs: () => personalSignArgs };
  }

  it("switchChain MUST precede sign7702Authorization, then {v,r,s} is serialized", async () => {
    // Produce a genuine {v,r,s} so Signature.from round-trips.
    const raw = wallet.signingKey.sign(
      hashAuthorization({ chainId: 8453, nonce: 3, address: wallet.address }),
    );
    const rvs = { v: Number(raw.v), r: raw.r, s: raw.s };
    const { magic, calls } = fakeMagic(rvs);

    const serialized = await magicSigner(magic, wallet.address).sign7702Auth({
      chainId: 8453,
      nonce: 3,
      address: "0xDELEGATE",
    });

    expect(calls).toEqual(["switchChain:8453", "sign7702:8453:3"]); // order is load-bearing
    expect(serialized).toBe(Signature.from(rvs).serialized);
  });

  it("signRootHash calls personal_sign with params [rootHash, eoa]", async () => {
    const { magic, personalSignArgs } = fakeMagic({ v: 27, r: "0x", s: "0x" });
    const sig = await magicSigner(magic, "0xEOA").signRootHash(ROOT_HASH);
    expect(sig).toBe("0xPERSONALSIG");
    expect(personalSignArgs()).toEqual({
      method: "personal_sign",
      params: [ROOT_HASH, "0xEOA"],
    });
  });
});
