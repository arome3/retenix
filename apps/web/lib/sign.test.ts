import { buildSignedMessage, computeInputHash, sigEnvelopeSchema } from "@retenix/shared";
import { verifyMessage, Wallet } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The client half of signedProcedure. Magic stands in for a key custodian, so an
 * ethers Wallet stands in for Magic: the server only recovers a signer from a
 * message, and cannot tell which one produced it.
 */
const request = vi.fn();
vi.mock("./magic", () => ({ magic: { rpcProvider: { request } } }));

const { personalSign, signEnvelope } = await import("./sign");

const wallet = new Wallet(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

beforeEach(() => {
  vi.clearAllMocks();
  request.mockImplementation(async ({ params }: { params: [string, string] }) =>
    wallet.signMessage(params[0]),
  );
});

describe("personalSign", () => {
  it("uses plain personal_sign with [message, eoa] in that order (G5)", async () => {
    await personalSign("hello", wallet.address);
    expect(request).toHaveBeenCalledExactlyOnceWith({
      method: "personal_sign",
      params: ["hello", wallet.address],
    });
  });

  it("never reaches for typed data", async () => {
    await personalSign("hello", wallet.address);
    const method = request.mock.calls[0][0].method as string;
    expect(method).not.toMatch(/typed/i);
  });
});

describe("signEnvelope", () => {
  it("signs exactly the preimage the server rebuilds", async () => {
    const payload = { planId: "abc", amountUsd: 25 };
    const { sig } = await signEnvelope("plans.activate", payload, wallet.address);

    const message = buildSignedMessage({
      route: "plans.activate",
      inputHash: computeInputHash(payload),
      nonce: sig.nonce,
      expiry: sig.expiry,
    });
    // What the server does, verbatim.
    expect(verifyMessage(message, sig.signature)).toBe(wallet.address);
  });

  it("returns the payload untouched alongside a valid envelope", async () => {
    const payload = { a: 1, b: [2, 3] };
    const result = await signEnvelope("sweep.execute", payload, wallet.address);
    expect(result.payload).toBe(payload);
    expect(() => sigEnvelopeSchema.parse(result.sig)).not.toThrow();
  });

  it("expires inside the server's five-minute window", async () => {
    const { sig } = await signEnvelope("kill.execute", {}, wallet.address);
    const now = Math.floor(Date.now() / 1000);
    expect(sig.expiry).toBeGreaterThan(now);
    expect(sig.expiry - now).toBeLessThanOrEqual(300);
  });

  it("uses a strictly increasing nonce, as the server's replay check requires", async () => {
    const first = await signEnvelope("kill.execute", {}, wallet.address);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await signEnvelope("kill.execute", {}, wallet.address);
    expect(second.sig.nonce).toBeGreaterThan(first.sig.nonce);
  });

  it("binds the signature to the route, so one cannot be replayed on another", async () => {
    const payload = { x: 1 };
    const { sig } = await signEnvelope("plans.activate", payload, wallet.address);
    const otherRoute = buildSignedMessage({
      route: "kill.execute",
      inputHash: computeInputHash(payload),
      nonce: sig.nonce,
      expiry: sig.expiry,
    });
    expect(verifyMessage(otherRoute, sig.signature)).not.toBe(wallet.address);
  });
});
