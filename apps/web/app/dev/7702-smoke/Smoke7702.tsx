"use client";

import { Signature } from "ethers";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ARBITRUM_MAINNET_ONE } from "@/lib/evm-endpoints";
import { magic } from "@/lib/magic";

/*
 * Gate G1 (doc 16, tech spec §15): Magic's own examples sign on Sepolia, and the
 * pairing must be proven on Arbitrum One before anything is built on it.
 *
 * Two things are being proven here, and the order between them is the point:
 * switchChain(42161) must precede sign7702Authorization for 42161, and the raw
 * authorization must survive ethers.Signature.from(raw).serialized — which is
 * exactly what doc 03's browser loop feeds into the UA SDK.
 *
 * Requires a logged-in Magic session (walk /welcome first) and real Magic keys.
 */
const DEFAULT_IMPLEMENTATION = "0x0000000000000000000000000000000000000000";

type Result =
  | { ok: true; serialized: string; raw: string }
  | { ok: false; error: string };

export function Smoke7702() {
  const [contractAddress, setContractAddress] = useState(DEFAULT_IMPLEMENTATION);
  const [nonce, setNonce] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      // Order matters. Doc 03's loop encodes it; this surface never hides it.
      await magic.evm.switchChain(ARBITRUM_MAINNET_ONE);

      const raw = await magic.wallet.sign7702Authorization({
        contractAddress,
        chainId: ARBITRUM_MAINNET_ONE,
        ...(nonce.trim() ? { nonce: Number(nonce) } : {}),
      });

      // The serialization doc 03 hands to the UA SDK.
      const serialized = Signature.from({
        v: raw.v,
        r: raw.r,
        s: raw.s,
      }).serialized;

      setResult({ ok: true, serialized, raw: JSON.stringify(raw, null, 2) });
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-[640px] space-y-6 p-6">
      <h1 className="font-display text-display">Gate G1 · 7702 on Arbitrum One</h1>
      <p className="text-small text-muted-foreground">
        Sign in first. This calls switchChain({ARBITRUM_MAINNET_ONE}) and then
        sign7702Authorization, and serializes the result the way doc 03 will.
      </p>

      <label className="block space-y-1">
        <span className="text-small text-muted-foreground">Implementation address</span>
        <Input
          value={contractAddress}
          onChange={(e) => setContractAddress(e.target.value)}
          className="font-mono"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-small text-muted-foreground">
          Account nonce (blank = fetched for you)
        </span>
        <Input value={nonce} onChange={(e) => setNonce(e.target.value)} inputMode="numeric" />
      </label>

      <Button onClick={run} disabled={busy}>
        {busy ? "Signing…" : "Run gate G1"}
      </Button>

      {result?.ok === true && (
        <div className="space-y-3 rounded-lg border border-positive p-4">
          <p className="text-body">PASS — serializable signature returned.</p>
          <pre className="overflow-x-auto font-mono text-caption">{result.raw}</pre>
          <p className="break-all font-mono text-caption">{result.serialized}</p>
        </div>
      )}
      {result?.ok === false && (
        <div className="space-y-2 rounded-lg border border-destructive p-4">
          <p className="text-body">FAIL</p>
          <pre className="overflow-x-auto font-mono text-caption">{result.error}</pre>
        </div>
      )}
    </main>
  );
}
