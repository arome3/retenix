// packages/ua/scripts/smoke.ts — the $1 mainnet convert smoke (doc 03 task 8).
//
// Backend signing flow only (walletSigner + a raw dev key). This is the module's
// backend definition-of-done and becomes the daily CI job (docs 16/17 wire it, not
// this file). It proves the whole pipeline end to end using @retenix/ua ALONE:
// createUa → getAddresses → createConvertTransaction → parseFeeTotals → signAndSend
// → pollToTerminal, then prints the universalx receipt link.
//
// Run:  pnpm --filter @retenix/ua smoke
// Env (canonical names, doc 00): PARTICLE_PROJECT_ID / PARTICLE_CLIENT_KEY /
//   PARTICLE_APP_UUID, SMOKE_WALLET_PRIVATE_KEY (capped $50 wallet, dev-only),
//   SMOKE_CONVERT_USD (default "1"). Optional SMOKE_CONVERT_CHAIN (default arbitrum),
//   SMOKE_CONVERT_TOKEN (default usdc). UA has NO testnet — mainnet within the
//   $5/day budget (G7).
import { Wallet } from "ethers";
import {
  activityUrl,
  CHAIN_ID,
  createConvertTransaction,
  createUa,
  getAddresses,
  getEIP7702Auth,
  getEIP7702Deployments,
  parseFeeTotals,
  pollToTerminal,
  signAndSend,
  SUPPORTED_TOKEN_TYPE,
  walletSigner,
  type ParticleCreds,
} from "../src/index";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[smoke] missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

const CHAIN_BY_NAME: Record<string, number> = {
  ethereum: CHAIN_ID.ETHEREUM_MAINNET,
  base: CHAIN_ID.BASE_MAINNET,
  arbitrum: CHAIN_ID.ARBITRUM_MAINNET_ONE,
  bsc: CHAIN_ID.BSC_MAINNET,
  xlayer: CHAIN_ID.XLAYER_MAINNET,
  solana: CHAIN_ID.SOLANA_MAINNET,
};
const TOKEN_BY_NAME: Record<string, SUPPORTED_TOKEN_TYPE> = {
  usdc: SUPPORTED_TOKEN_TYPE.USDC,
  usdt: SUPPORTED_TOKEN_TYPE.USDT,
  eth: SUPPORTED_TOKEN_TYPE.ETH,
  bnb: SUPPORTED_TOKEN_TYPE.BNB,
  sol: SUPPORTED_TOKEN_TYPE.SOL,
};

async function main(): Promise<number> {
  const credentials: ParticleCreds = {
    projectId: required("PARTICLE_PROJECT_ID"),
    projectClientKey: required("PARTICLE_CLIENT_KEY"),
    projectAppUuid: required("PARTICLE_APP_UUID"),
  };
  const wallet = new Wallet(required("SMOKE_WALLET_PRIVATE_KEY"));
  const usd = process.env.SMOKE_CONVERT_USD ?? "1";
  const chainId =
    CHAIN_BY_NAME[(process.env.SMOKE_CONVERT_CHAIN ?? "arbitrum").toLowerCase()] ??
    CHAIN_ID.ARBITRUM_MAINNET_ONE;
  const tokenType =
    TOKEN_BY_NAME[(process.env.SMOKE_CONVERT_TOKEN ?? "usdc").toLowerCase()] ??
    SUPPORTED_TOKEN_TYPE.USDC;

  const ua = createUa({ ownerAddress: wallet.address, credentials });

  const addrs = await getAddresses(ua);
  console.log(
    `[smoke] EOA=${addrs.eoa}  UA(EVM)=${addrs.uaEvm}  UA(SOL)=${addrs.uaSol}`,
  );

  // OQ5 introspection (task 9): capture the concrete mainnet return shapes of the
  // Promise<any> methods so the owner can freeze their interfaces in this package.
  // Non-fatal — logs and continues.
  await logOq5Shapes(ua, chainId);

  console.log(
    `[smoke] convert → ${usd} ${tokenType} on chain ${chainId} (create → sign → send, one continuous flow)`,
  );
  // Quotes expire — create, sign, and send without persisting the tx.
  const tx = await createConvertTransaction(ua, {
    chainId,
    expectToken: { type: tokenType, amount: usd },
  });

  const fees = parseFeeTotals(tx);
  console.log(
    `[smoke] fees: total $${fees.total.toFixed(6)} (gas $${fees.gas.toFixed(6)}, service $${fees.service.toFixed(6)}, LP $${fees.lp.toFixed(6)})`,
  );

  const { transactionId } = await signAndSend(ua, tx, walletSigner(wallet));
  console.log(`[smoke] submitted transactionId=${transactionId}`);
  console.log(`[smoke] receipt: ${activityUrl(transactionId)}`);

  const { outcome, t } = await pollToTerminal(ua, transactionId);
  console.log(`[smoke] outcome=${outcome} status=${t.status}`);

  if (outcome === "finished") {
    console.log(`[smoke] OK — $${usd} convert FINISHED`);
    return 0;
  }
  // REFUND states are failed-with-refund; timeouts may still settle. Either way this
  // is a non-success for the smoke gate.
  console.error(
    `[smoke] FAILED — outcome=${outcome}. Receipt: ${activityUrl(transactionId)}`,
  );
  return 1;
}

async function logOq5Shapes(
  ua: ReturnType<typeof createUa>,
  chainId: number,
): Promise<void> {
  try {
    const deployments = await getEIP7702Deployments(ua);
    console.log(
      "[smoke] OQ5 getEIP7702Deployments():",
      JSON.stringify(deployments),
    );
    const auth = await getEIP7702Auth(ua, [chainId]);
    console.log(
      `[smoke] OQ5 getEIP7702Auth([${chainId}]):`,
      JSON.stringify(auth),
    );
  } catch (err) {
    console.warn(
      "[smoke] OQ5 introspection skipped:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(
      "[smoke] error:",
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    process.exit(1);
  });
