// packages/ua/scripts/send-smoke.ts — the $1 mainnet USDC transfer smoke
// (doc 15, owner-run half of the send DoD) + the OQ5 capture.
//
// Backend signing flow (walletSigner + the capped smoke wallet): proves
// createTransferTransaction → parseFeeTotals → signAndSend → pollToTerminal
// end to end WITHOUT Magic — the browser flow differs only in the signer.
// Also logs the RAW getEIP7702Deployments / getEIP7702Auth payloads: paste
// them into docs/prompts/HANDOFF.md and reconcile the PROVISIONAL interfaces
// in src/methods.ts if they differ (closing OQ5 for real).
//
// Run:  pnpm --filter @retenix/ua smoke:send
// Env (doc 00 canonical + smoke conventions): PARTICLE_PROJECT_ID /
//   PARTICLE_CLIENT_KEY / PARTICLE_APP_UUID, SMOKE_WALLET_PRIVATE_KEY,
//   SMOKE_SEND_RECEIVER (the external address the $1 goes to — an owner
//   wallet; there is no return path), SMOKE_SEND_USD (default "1").
//   Budget: G7 — $50 wallet / $5 day; this spends ~$1 + fees.
import { Wallet } from "ethers";
import {
  activityUrl,
  CHAIN_ID,
  createTransferTransaction,
  createUa,
  getAddresses,
  getEIP7702Auth,
  getEIP7702Deployments,
  parseEIP7702AuthTargets,
  parseEIP7702Deployments,
  parseFeeTotals,
  pollToTerminal,
  primaryTokenFor,
  signAndSend,
  SUPPORTED_TOKEN_TYPE,
  walletSigner,
  type ParticleCreds,
} from "../src/index";

const PLACEHOLDER = /PLACEHOLDER|^0{8}/;

function gated(name: string): string | null {
  const value = process.env[name];
  if (!value || PLACEHOLDER.test(value)) return null;
  return value;
}

async function main(): Promise<number> {
  const projectId = gated("PARTICLE_PROJECT_ID");
  const projectClientKey = gated("PARTICLE_CLIENT_KEY");
  const projectAppUuid = gated("PARTICLE_APP_UUID");
  const key = gated("SMOKE_WALLET_PRIVATE_KEY");
  const receiver = process.env.SMOKE_SEND_RECEIVER;

  if (!projectId || !projectClientKey || !projectAppUuid || !key || !receiver) {
    console.log("[send-smoke] OWNER ACTION REQUIRED — nothing was executed:");
    console.log("  • set PARTICLE_PROJECT_ID / PARTICLE_CLIENT_KEY / PARTICLE_APP_UUID");
    console.log("  • set SMOKE_WALLET_PRIVATE_KEY (the capped $50 smoke wallet)");
    console.log("  • set SMOKE_SEND_RECEIVER (an owner-controlled external address)");
    console.log("  • then: pnpm --filter @retenix/ua smoke:send");
    return 0;
  }

  const credentials: ParticleCreds = { projectId, projectClientKey, projectAppUuid };
  const wallet = new Wallet(key);
  const ua = createUa({ ownerAddress: wallet.address, credentials });
  const addresses = await getAddresses(ua);
  console.log(`[send-smoke] owner ${addresses.eoa} → receiver ${receiver}`);

  // --- OQ5 capture (read-only; runs even if the transfer later fails) ------
  try {
    const deployments = await getEIP7702Deployments(ua);
    console.log("[send-smoke] OQ5 getEIP7702Deployments RAW:");
    console.log(JSON.stringify(deployments, null, 2));
    const parsed = parseEIP7702Deployments(deployments);
    console.log(
      parsed === null
        ? "[send-smoke] ⚠ PROVISIONAL PARSER REJECTED the live shape — reconcile src/methods.ts"
        : `[send-smoke] provisional parser OK (${parsed.length} rows)`,
    );
  } catch (err) {
    console.log(`[send-smoke] getEIP7702Deployments failed: ${String(err).slice(0, 200)}`);
  }
  try {
    const auth = await getEIP7702Auth(ua, [CHAIN_ID.ARBITRUM_MAINNET_ONE]);
    console.log("[send-smoke] OQ5 getEIP7702Auth([42161]) RAW:");
    console.log(JSON.stringify(auth, null, 2));
    const parsed = parseEIP7702AuthTargets(auth);
    console.log(
      parsed === null
        ? "[send-smoke] ⚠ PROVISIONAL PARSER REJECTED the live shape — reconcile src/methods.ts"
        : `[send-smoke] provisional parser OK (${parsed.length} targets)`,
    );
  } catch (err) {
    console.log(`[send-smoke] getEIP7702Auth failed: ${String(err).slice(0, 200)}`);
  }

  // --- the $1 transfer ------------------------------------------------------
  const usd = process.env.SMOKE_SEND_USD ?? "1";
  const usdc = primaryTokenFor(SUPPORTED_TOKEN_TYPE.USDC, CHAIN_ID.ARBITRUM_MAINNET_ONE);
  if (!usdc) {
    console.error("[send-smoke] USDC settle token missing from the SDK constants");
    return 1;
  }
  const tx = await createTransferTransaction(ua, {
    token: { chainId: usdc.chainId, address: usdc.address },
    amount: usd, // USDC: 1 USD ≡ 1 token unit (human string)
    receiver,
  });
  const fees = parseFeeTotals(tx);
  console.log(
    `[send-smoke] transfer $${usd} USDC — fees $${fees.total.toFixed(4)} (gas ${fees.gas.toFixed(4)}, service ${fees.service.toFixed(4)}, lp ${fees.lp.toFixed(4)})`,
  );

  const signer = walletSigner(wallet);
  const { transactionId } = await signAndSend(ua, tx, signer);
  console.log(`[send-smoke] sent — ${activityUrl(transactionId)}`);

  const settled = await pollToTerminal(ua, transactionId, {
    intervalMs: 2000,
    timeoutMs: 180_000,
  });
  console.log(`[send-smoke] outcome: ${settled.outcome}`);
  return settled.outcome === "finished" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[send-smoke] failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
