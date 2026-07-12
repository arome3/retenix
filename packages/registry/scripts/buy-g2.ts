// packages/registry/scripts/buy-g2.ts — gate G2 (doc 05 / doc 16): the $5 SPYx
// mainnet buy. Validates the PINNED MINT + UA ROUTING together — the single
// biggest demo risk (OQ7 / TS-17.7).
//
// Backend signing flow (walletSigner + a capped dev key), mirroring
// packages/ua/scripts/smoke.ts:
//   REGISTRY.find(spyx) → createBuyTransaction → parseFeeTotals → signAndSend →
//   pollToTerminal → assert FINISHED and the pinned mint is in the tx detail.
//
// Run:  pnpm --filter @retenix/registry buy:g2
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
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.log(
      [
        "[g2] SKIPPED — the $5 SPYx mainnet buy is a flagged owner-action (OQ7 / TS-17.7),",
        "[g2] the single biggest demo risk. This is NOT a package failure.",
        `[g2] Missing env: ${missing.join(", ")}.`,
        "[g2] Set PARTICLE_* + SMOKE_WALLET_PRIVATE_KEY (capped $50 wallet) to execute.",
        "[g2] On routing failure, activate the PS-11.2 fallback (SOL/USDC + a mocked,",
        "[g2] honestly-labeled ticker) and ask Particle Telegram about the routing whitelist.",
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
  console.log(
    `[g2] target ${asset.ticker} — pinned mint ${asset.address} (chain ${asset.chainId})`,
  );

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
