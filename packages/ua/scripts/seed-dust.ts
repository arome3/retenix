// packages/ua/scripts/seed-dust.ts — fund the demo account with dust (doc 06
// task 12; doc 16's runbook references this).
//
// Seeds small non-primary token balances onto the demo account across ≥3
// networks so sweep.preview finds real dust and demo beat 2 runs live. Driven
// entirely from the capped smoke wallet's UA: for each pinned seed token,
// transfer what the wallet already holds, or buy ~$SEED_DUST_USD of it first
// (createBuyTransaction) and then transfer the received balance to the demo
// account. Mainnet only (G7 — UA has no testnet); keep amounts tiny.
//
// Run:  pnpm --filter @retenix/ua seed:dust
// Env (canonical where canonical names exist, doc 00):
//   PARTICLE_PROJECT_ID / PARTICLE_CLIENT_KEY / PARTICLE_APP_UUID
//   SMOKE_WALLET_PRIVATE_KEY   the capped $50 dev wallet
//   DEMO_EOA_ADDR              the demo account's EVM address (its UA in 7702)
//   SEED_DUST_USD              per-token buy size, default "0.60", max "2"
// Absent credentials → prints the owner-action and exits 0 (buy-g2 pattern):
// this script is demo tooling, not a CI gate.
//
// Seed tokens are WELL-KNOWN, liquid, non-primary, non-registry assets —
// exactly what the scanner treats as dust. Verify addresses before a run that
// matters; amounts bound the blast radius to ~$2 total.
import { Contract, JsonRpcProvider, Wallet, formatUnits } from "ethers";
import {
  activityUrl,
  CHAIN_ID,
  createBuyTransaction,
  createTransferTransaction,
  createUa,
  getAddresses,
  parseFeeTotals,
  pollToTerminal,
  signAndSend,
  walletSigner,
  type ParticleCreds,
  type UniversalAccount,
} from "../src/index";

interface SeedToken {
  chainId: number;
  address: string;
  symbol: string;
  /** Read-only public endpoint for the balance check (constants, doc 02 pattern). */
  rpc: string;
}

const SEEDS: SeedToken[] = [
  {
    chainId: CHAIN_ID.ARBITRUM_MAINNET_ONE,
    address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", // LINK (Arbitrum)
    symbol: "LINK",
    rpc: "https://arb1.arbitrum.io/rpc",
  },
  {
    chainId: CHAIN_ID.BASE_MAINNET,
    address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", // DEGEN (Base)
    symbol: "DEGEN",
    rpc: "https://mainnet.base.org",
  },
  {
    chainId: CHAIN_ID.BSC_MAINNET,
    address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", // CAKE (BSC)
    symbol: "CAKE",
    rpc: "https://bsc-dataseed.bnbchain.org",
  },
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

function env(name: string): string | undefined {
  return process.env[name] || undefined;
}

async function seedOne(
  ua: UniversalAccount,
  wallet: Wallet,
  uaEvm: string,
  demoAddr: string,
  seed: SeedToken,
  buyUsd: string,
): Promise<boolean> {
  const signer = walletSigner(wallet);
  const erc20 = new Contract(seed.address, ERC20_ABI, new JsonRpcProvider(seed.rpc));
  const decimals = Number(await erc20.decimals());

  let balance: bigint = await erc20.balanceOf(uaEvm);
  if (balance === 0n) {
    console.log(`[seed] ${seed.symbol}@${seed.chainId}: buying ~$${buyUsd}…`);
    // Quotes expire — create → sign → send in one continuous flow.
    const buy = await createBuyTransaction(ua, {
      token: { chainId: seed.chainId, address: seed.address },
      amountInUSD: buyUsd,
    });
    const fees = parseFeeTotals(buy);
    const { transactionId } = await signAndSend(ua, buy, signer);
    console.log(
      `[seed]   buy fees $${fees.total.toFixed(4)} → ${activityUrl(transactionId)}`,
    );
    const settled = await pollToTerminal(ua, transactionId);
    if (settled.outcome !== "finished") {
      console.error(`[seed]   buy did not finish (${settled.outcome}) — skipping token`);
      return false;
    }
    balance = await erc20.balanceOf(uaEvm);
    if (balance === 0n) {
      console.error(`[seed]   bought but balance still 0 — routing lag? skipping`);
      return false;
    }
  }

  const amount = formatUnits(balance, decimals);
  console.log(
    `[seed] ${seed.symbol}@${seed.chainId}: transferring ${amount} → ${demoAddr}`,
  );
  const transfer = await createTransferTransaction(ua, {
    token: { chainId: seed.chainId, address: seed.address },
    amount,
    receiver: demoAddr,
  });
  const { transactionId } = await signAndSend(ua, transfer, signer);
  console.log(`[seed]   transfer → ${activityUrl(transactionId)}`);
  const settled = await pollToTerminal(ua, transactionId);
  if (settled.outcome !== "finished") {
    console.error(`[seed]   transfer did not finish (${settled.outcome})`);
    return false;
  }
  return true;
}

async function main(): Promise<number> {
  const projectId = env("PARTICLE_PROJECT_ID");
  const clientKey = env("PARTICLE_CLIENT_KEY");
  const appUuid = env("PARTICLE_APP_UUID");
  const smokeKey = env("SMOKE_WALLET_PRIVATE_KEY");
  const demoAddr = env("DEMO_EOA_ADDR");

  if (!projectId || !clientKey || !appUuid || !smokeKey || !demoAddr) {
    console.log(
      "[seed] OWNER-ACTION (doc 06 / doc 16 runbook): set PARTICLE_PROJECT_ID, " +
        "PARTICLE_CLIENT_KEY, PARTICLE_APP_UUID, SMOKE_WALLET_PRIVATE_KEY and " +
        "DEMO_EOA_ADDR, then re-run `pnpm --filter @retenix/ua seed:dust` to " +
        "fund the demo account with dust on 3 networks (mainnet, ~$2 total). " +
        "Nothing was executed.",
    );
    return 0;
  }

  const buyUsd = env("SEED_DUST_USD") ?? "0.60";
  if (Number(buyUsd) > 2) {
    console.error(`[seed] SEED_DUST_USD=${buyUsd} exceeds the $2 per-token cap (G7: seed small)`);
    return 1;
  }

  const credentials: ParticleCreds = {
    projectId,
    projectClientKey: clientKey,
    projectAppUuid: appUuid,
  };
  const wallet = new Wallet(smokeKey);
  const ua = createUa({ ownerAddress: wallet.address, credentials });
  const addrs = await getAddresses(ua);
  console.log(`[seed] smoke UA(EVM)=${addrs.uaEvm} → demo=${demoAddr}`);

  let seeded = 0;
  for (const seed of SEEDS) {
    try {
      if (await seedOne(ua, wallet, addrs.uaEvm, demoAddr, seed, buyUsd)) seeded++;
    } catch (err) {
      console.error(
        `[seed] ${seed.symbol}@${seed.chainId} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  console.log(`[seed] done — ${seeded}/${SEEDS.length} tokens landed on the demo account`);
  // ≥2 networks is the doc-06 integration bar; ≥3 is this script's target.
  return seeded >= 2 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(
      "[seed] error:",
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    process.exit(1);
  });
