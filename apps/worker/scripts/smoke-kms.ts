// $1 mainnet convert through the AWS KMS signer (doc 08 task 10) — proves
// the KMS DER→RSV path end to end against Particle: GetPublicKey → address,
// EIP-191 rootHash digest signature, 7702 hashAuthorization signatures.
// Mirrors packages/ua/scripts/smoke.ts, swapping walletSigner for kmsUaSigner.
//
// Run: pnpm --filter worker smoke:kms   (worker .env must carry REAL
// PARTICLE_* + AWS_REGION/KMS_AGENT_KEY_ID with IAM access; the agent UA
// needs ≥ ~$1.50 of primary assets. G7: mainnet, $5/day budget.)

import { KMSClient } from "@aws-sdk/client-kms";
import {
  CHAIN_ID,
  SUPPORTED_TOKEN_TYPE,
  activityUrl,
  createConvertTransaction,
  createUa,
  getAddresses,
  getPrimaryAssets,
  parseFeeTotals,
  pollToTerminal,
  signAndSend,
} from "@retenix/ua";

import { env } from "../env";
import { KmsKey, kmsUaSigner, type KmsClientLike } from "../src/kms";
import { ownerAction, particleReady } from "./lib";

async function main(): Promise<number> {
  if (!particleReady()) {
    ownerAction("smoke-kms", [
      "set real PARTICLE_PROJECT_ID / PARTICLE_CLIENT_KEY / PARTICLE_APP_UUID in apps/worker/.env",
    ]);
  }

  const client = new KMSClient({ region: env.AWS_REGION }) as unknown as KmsClientLike;
  const kms = new KmsKey(client, env.KMS_AGENT_KEY_ID);
  let address: string;
  try {
    address = await kms.address();
  } catch (err) {
    ownerAction("smoke-kms", [
      "create the agent key: aws kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY",
      "set KMS_AGENT_KEY_ID to its ARN and grant kms:GetPublicKey + kms:Sign to this principal",
      `KMS said: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  console.log(`[smoke-kms] agent EOA (derived from the KMS public key): ${address}`);

  const ua = createUa({
    ownerAddress: address,
    credentials: {
      projectId: env.PARTICLE_PROJECT_ID,
      projectClientKey: env.PARTICLE_CLIENT_KEY,
      projectAppUuid: env.PARTICLE_APP_UUID,
    },
  });
  const addrs = await getAddresses(ua);
  console.log(`[smoke-kms] UA(EVM)=${addrs.uaEvm} UA(SOL)=${addrs.uaSol}`);

  const assets = await getPrimaryAssets(ua);
  const total = Number(assets.totalAmountInUSD ?? 0);
  if (total < 1.5) {
    ownerAction("smoke-kms", [
      `fund the agent UA (${addrs.uaEvm}) with ≥ $1.50 of primary assets (currently $${total.toFixed(2)})`,
      "also keep a little ETH on Arbitrum One at the EOA for recordExecution gas (doc 08 ops note)",
    ]);
  }

  const usd = process.env.SMOKE_CONVERT_USD ?? "1";
  console.log(`[smoke-kms] convert → $${usd} USDC on Arbitrum via the KMS signer`);
  const tx = await createConvertTransaction(ua, {
    chainId: CHAIN_ID.ARBITRUM_MAINNET_ONE,
    expectToken: { type: SUPPORTED_TOKEN_TYPE.USDC, amount: usd },
  });
  const fees = parseFeeTotals(tx);
  console.log(
    `[smoke-kms] fees: total $${fees.total.toFixed(6)} (gas $${fees.gas.toFixed(6)}, service $${fees.service.toFixed(6)}, LP $${fees.lp.toFixed(6)})`,
  );

  // create → sign → send in one continuous flow; every signature below is
  // KMS DER → r/s/v (low-s) — the exact path production executions use.
  const { transactionId } = await signAndSend(ua, tx, kmsUaSigner(kms));
  console.log(`[smoke-kms] submitted ${transactionId} → ${activityUrl(transactionId)}`);

  const { outcome, t } = await pollToTerminal(ua, transactionId);
  console.log(`[smoke-kms] outcome=${outcome} status=${t.status}`);
  if (outcome === "finished") {
    console.log("[smoke-kms] OK — the KMS DER→RSV signer executed a mainnet UA transaction");
    return 0;
  }
  console.error(`[smoke-kms] FAILED — outcome=${outcome}; ${activityUrl(transactionId)}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[smoke-kms] error:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
