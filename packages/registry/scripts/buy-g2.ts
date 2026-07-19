// packages/registry/scripts/buy-g2.ts — gate G2 (doc 05 / doc 16): the $5 SPYx
// mainnet buy. Validates the PINNED MINT + UA ROUTING together — the single
// biggest demo risk (OQ7 / TS-17.7).
//
// DOUBLES AS GATE G-R1 (doc 20) for tokenized gold: run with G2_BUY_ID=paxg
// (`pnpm --filter @retenix/registry buy:gr1`) to prove the pinned PAXG contract
// routes on Ethereum mainnet. G-R3: PAXG's on-chain transfer fee is currently
// ZERO (Paxos disabled it), so received should ≈ quoted — but the mechanism can
// be re-enabled, so the owner MUST confirm received-vs-quoted within tolerance
// from the logged tx detail (the received-amount field is unfrozen in 2.0.3).
//
// Backend signing flow (walletSigner + a capped dev key), mirroring
// packages/ua/scripts/smoke.ts:
//   REGISTRY.find(id) → createBuyTransaction → parseFeeTotals → signAndSend →
//   pollToTerminal → assert FINISHED and the pinned address is in the tx detail.
//
// Run:  pnpm --filter @retenix/registry buy:g2   (SPYx / gate G2)
//       pnpm --filter @retenix/registry buy:gr1  (PAXG / gate G-R1, doc 20)
// Env (canonical names, doc 00): PARTICLE_PROJECT_ID / PARTICLE_CLIENT_KEY /
//   PARTICLE_APP_UUID, SMOKE_WALLET_PRIVATE_KEY (capped $50 wallet, dev-only).
//   Optional: G2_BUY_USD (default "5"), G2_BUY_ID (default "spyx").
//
// If those creds are ABSENT, this prints an OQ7 flagged-owner-action and exits 0
// — the buy is a week-1 owner action, not a failure of this package. UA has no
// testnet: mainnet only, within the $5/day budget (G1/G7).
import { Wallet } from "ethers";
import {
  activityUrl,
  createBuyTransaction,
  createUa,
  getAddresses,
  parseFeeTotals,
  pollToTerminal,
  signAndSend,
  walletSigner,
  type ParticleCreds,
} from "@retenix/ua";
import { REGISTRY } from "../src/index";

const REQUIRED = [
  "PARTICLE_PROJECT_ID",
  "PARTICLE_CLIENT_KEY",
  "PARTICLE_APP_UUID",
  "SMOKE_WALLET_PRIVATE_KEY",
] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[g2] missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<number> {
  const targetId = process.env.G2_BUY_ID ?? "spyx";
  const isGold = targetId === "paxg" || targetId === "xaut";
  const tag = isGold ? "G-R1" : "g2";
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    const buyDesc = isGold
      ? `the $${process.env.G2_BUY_USD ?? "5"} PAXG mainnet buy is a flagged owner-action (G-R1, doc 20)`
      : "the $5 SPYx mainnet buy is a flagged owner-action (OQ7 / TS-17.7)";
    console.log(
      [
        `[${tag}] SKIPPED — ${buyDesc},`,
        `[${tag}] the single biggest demo risk. This is NOT a package failure.`,
        `[${tag}] Missing env: ${missing.join(", ")}.`,
        `[${tag}] Set PARTICLE_* + SMOKE_WALLET_PRIVATE_KEY (capped $50 wallet) to execute.`,
        isGold
          ? `[${tag}] G-R3: confirm received-vs-quoted within tolerance; drop XAUT silently if routing fails (PAXG suffices).`
          : `[${tag}] On routing failure, activate the PS-11.2 fallback (SOL/USDC + a mocked, honestly-labeled ticker).`,
      ].join("\n"),
    );
    return 0; // absence is expected, not a failure
  }

  const credentials: ParticleCreds = {
    projectId: required("PARTICLE_PROJECT_ID"),
    projectClientKey: required("PARTICLE_CLIENT_KEY"),
    projectAppUuid: required("PARTICLE_APP_UUID"),
  };
  const wallet = new Wallet(required("SMOKE_WALLET_PRIVATE_KEY"));
  const usd = process.env.G2_BUY_USD ?? "5";
  const id = process.env.G2_BUY_ID ?? "spyx";

  const asset = REGISTRY.find((a) => a.id === id);
  if (!asset) {
    console.error(`[g2] no registry asset with id "${id}"`);
    return 1;
  }
  const gate =
    asset.kind === "rwa-gold" ? "G-R1" : asset.kind === "leveraged" ? "G-L1" : "G2";
  console.log(
    `[${gate}] target ${asset.ticker} — pinned address ${asset.address} (chain ${asset.chainId})`,
  );
  if (asset.kind === "leveraged") {
    console.log(
      "[G-L1] leveraged Series Token (doc 18 F11). LIQUIDITY IS THIN — TSL2L " +
        "measured ~$192 of 24h volume and 99.19% top-holder concentration on " +
        "2026-07-18, ~200x below doc 18's '~$40M' claim. A $5 buy is a material " +
        "fraction of a day's volume: RECORD THE REALIZED SLIPPAGE below, and run " +
        "the SELL half too — a mint that cannot be sold must not stay pinned.",
    );
  }
  if (asset.kind === "rwa-gold") {
    console.log(
      "[G-R1] gold buy (doc 20). G-R3: confirm received-vs-quoted within tolerance " +
        "from the tx detail below — PAXG's on-chain fee is currently zero, but verify.",
    );
  }

  const ua = createUa({ ownerAddress: wallet.address, credentials });
  const addrs = await getAddresses(ua);
  console.log(
    `[g2] EOA=${addrs.eoa} UA(EVM)=${addrs.uaEvm} UA(SOL)=${addrs.uaSol}`,
  );

  // Quotes expire — create, sign, and send in one continuous flow; never persist.
  console.log(`[g2] buy → $${usd} ${asset.ticker} (create → sign → send)`);
  const tx = await createBuyTransaction(ua, {
    token: { chainId: asset.chainId, address: asset.address },
    amountInUSD: usd,
  });

  const fees = parseFeeTotals(tx);
  console.log(
    `[g2] fees: total $${fees.total.toFixed(6)} (gas $${fees.gas.toFixed(6)}, service $${fees.service.toFixed(6)}, LP $${fees.lp.toFixed(6)})`,
  );

  const { transactionId } = await signAndSend(ua, tx, walletSigner(wallet));
  console.log(`[g2] submitted transactionId=${transactionId}`);
  console.log(`[g2] receipt: ${activityUrl(transactionId)}`);

  const { outcome, t } = await pollToTerminal(ua, transactionId);
  console.log(`[g2] outcome=${outcome} status=${t.status}`);

  // The exact "received mint" field on the getTransaction payload is unfrozen
  // (Promise<any> in 2.0.3). Log the whole payload so the owner can freeze the
  // field, then assert the pinned mint appears in the completed tx detail — the
  // on-chain half of the fake-mint defense (doc 05 §security).
  console.log(
    "[g2] tx detail (freeze the received-mint field from this):",
    JSON.stringify(t),
  );

  if (outcome !== "finished") {
    console.error(
      `[g2] FAILED — outcome=${outcome}. Receipt: ${activityUrl(transactionId)}`,
    );
    return 1;
  }
  if (!JSON.stringify(t).includes(asset.address)) {
    console.error(
      `[g2] FAIL — pinned mint ${asset.address} NOT found in the completed tx detail (possible fake-mint / routing mismatch).`,
    );
    return 1;
  }
  console.log(
    `[g2] OK — $${usd} ${asset.ticker} FINISHED; pinned mint ${asset.address} present in tx detail.`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(
      "[g2] error:",
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    process.exit(1);
  });
