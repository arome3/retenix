// Gate G4 (doc 14, blocking): escrowed re-delegation end-to-end on one chain.
// Proves, in order:
//   1. HAPPY PATH — owner signs a 7702 tuple delegating to RetenixClaim,
//      bound to the EOA's current nonce; the tuple round-trips through the
//      REAL escrow envelope (encrypt → decrypt); the keeper applies it as a
//      Type-4 transaction (same tx calls registerHeir); claim() moves a test
//      token AND the native balance to the heir.
//   2. SELF-INVALIDATION (the mechanism's whole argument) — the owner sends
//      any transaction (nonce bump), the stale tuple's Type-4 SUCCEEDS as a
//      transaction but the tuple is silently SKIPPED: no code lands on the
//      EOA, no HeirRegistered event. This is why the keeper MUST verify
//      getCode after every apply — receipt status 1 proves nothing.
//   3. REFRESH — a fresh tuple at the new nonce applies cleanly (the login
//      re-sign ceremony's backend truth).
//   4. RESUME — an apply whose inner call reverts still applies the
//      delegation (7702 semantics); a plain Type-2 registerHeir completes it
//      WITHOUT re-burning a tuple.
//
// Default mode spawns a local anvil (Prague hardfork) — no funds at risk.
// Live mode (G7: mainnet, tiny balances) runs against a real chain:
//   G4_RPC_URL, G4_KEEPER_PRIVATE_KEY (must be the delegate's keeper),
//   G4_OWNER_PRIVATE_KEY (a throwaway with a few cents of gas),
//   G4_CLAIM_DELEGATE (deployed RetenixClaim), optional G4_TOKEN (ERC-20 the
//   owner holds; omitted → native-only claim), G4_HEIR (defaults to keeper).
//
// Run: pnpm --filter worker rehearse:g4
/* eslint-disable no-console */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  NonceManager,
  Signature,
  Wallet,
  parseEther,
  type Authorization,
  type TransactionReceipt,
} from "ethers";
import {
  decryptEnvelope,
  devEscrowProvider,
  encryptEnvelope,
} from "@retenix/shared/escrow";
import { escrowTupleSchema, type EscrowTuple } from "@retenix/shared";

const here = dirname(fileURLToPath(import.meta.url));
const ANVIL_PORT = 8547;
// anvil's well-known dev key #0 — public test constant, never a secret
const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const CHECKS: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  CHECKS.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`G4 check failed: ${name}`);
}

function artifact(file: string, contract: string): { abi: unknown[]; bytecode: string } {
  const path = resolve(here, `../../../contracts/out/${file}/${contract}.json`);
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

/** Serialize an ethers Authorization into the escrowed-tuple wire shape. */
function toTuple(auth: Authorization): EscrowTuple {
  return escrowTupleSchema.parse({
    chainId: Number(auth.chainId),
    address: auth.address,
    nonce: Number(auth.nonce),
    yParity: auth.signature.yParity,
    r: auth.signature.r,
    s: auth.signature.s,
  });
}

/** Rebuild the ethers authorizationList entry from a stored tuple. */
function fromTuple(t: EscrowTuple): Authorization {
  return {
    address: t.address,
    nonce: BigInt(t.nonce),
    chainId: BigInt(t.chainId),
    signature: Signature.from({ r: t.r, s: t.s, yParity: t.yParity }),
  };
}

function delegatedCode(delegate: string): string {
  return `0xef0100${delegate.slice(2).toLowerCase()}`;
}

async function waitReceipt(
  provider: JsonRpcProvider,
  hash: string,
): Promise<TransactionReceipt> {
  const receipt = await provider.waitForTransaction(hash);
  if (!receipt) throw new Error(`no receipt for ${hash}`);
  return receipt;
}

/** Escrow round-trip: the tuple set is stored/read EXACTLY as production
 *  does it (estates.tuples_enc format). */
async function escrowRoundTrip(owner: string, tuples: EscrowTuple[]): Promise<EscrowTuple[]> {
  const provider = devEscrowProvider("g4-rehearsal-escrow-secret");
  const ctx = { owner, purpose: "estate-tuples" as const };
  const blob = await encryptEnvelope(provider, ctx, JSON.stringify(tuples));
  const out = JSON.parse((await decryptEnvelope(provider, ctx, blob)).toString("utf8"));
  return (out as unknown[]).map((t) => escrowTupleSchema.parse(t));
}

interface Env {
  provider: JsonRpcProvider;
  /** NonceManager-wrapped: serialized sends never race a cached nonce. */
  keeper: NonceManager;
  keeperAddress: string;
  heir: string;
  claimDelegate: string;
  claimAbi: unknown[];
  token: Contract | null;
  /** mint(to, amount) available? (anvil mode only) */
  canMint: boolean;
  fundOwner: (owner: string, eth: string) => Promise<void>;
  anvil: ChildProcess | null;
  live: boolean;
  ownerForHappyPath: Wallet;
  freshOwner: () => Wallet;
}

async function setupAnvil(): Promise<Env> {
  console.log(`\nspawning anvil --hardfork prague on :${ANVIL_PORT} …`);
  const anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--hardfork", "prague", "--silent"], {
    stdio: "ignore",
  });
  const provider = new JsonRpcProvider(`http://127.0.0.1:${ANVIL_PORT}`, undefined, {
    polling: true, pollingInterval: 100,
  });
  for (let i = 0; ; i++) {
    try {
      await provider.getBlockNumber();
      break;
    } catch {
      if (i > 100) throw new Error("anvil did not come up");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const keeperWallet = new Wallet(ANVIL_KEY_0, provider);
  const keeper = new NonceManager(keeperWallet);

  const claimArt = artifact("RetenixClaim.sol", "RetenixClaim");
  const claim = await new ContractFactory(claimArt.abi, claimArt.bytecode, keeper).deploy(
    keeperWallet.address,
    "0x0000000000000000000000000000000000000000",
  );
  await claim.waitForDeployment();

  const mockArt = artifact("ClaimDelegate.t.sol", "MockERC20");
  const token = await new ContractFactory(mockArt.abi, mockArt.bytecode, keeper).deploy();
  await token.waitForDeployment();

  return {
    provider,
    keeper,
    keeperAddress: keeperWallet.address,
    heir: Wallet.createRandom().address,
    claimDelegate: await claim.getAddress(),
    claimAbi: claimArt.abi,
    token: new Contract(await token.getAddress(), mockArt.abi, keeper),
    canMint: true,
    fundOwner: async (owner, eth) => {
      await waitReceipt(provider, (await keeper.sendTransaction({ to: owner, value: parseEther(eth) })).hash);
    },
    anvil,
    live: false,
    ownerForHappyPath: new Wallet(Wallet.createRandom().privateKey, provider),
    freshOwner: () => new Wallet(Wallet.createRandom().privateKey, provider),
  };
}

async function setupLive(): Promise<Env> {
  const { env: workerEnv } = process as unknown as { env: Record<string, string | undefined> };
  const rpc = workerEnv.G4_RPC_URL!;
  const provider = new JsonRpcProvider(rpc);
  const keeperWallet = new Wallet(workerEnv.G4_KEEPER_PRIVATE_KEY!, provider);
  const keeper = new NonceManager(keeperWallet);
  const owner = new Wallet(workerEnv.G4_OWNER_PRIVATE_KEY!, provider);
  const claimDelegate = workerEnv.G4_CLAIM_DELEGATE!;
  const claimArt = artifact("RetenixClaim.sol", "RetenixClaim");
  const tokenAddr = workerEnv.G4_TOKEN;
  const erc20Abi = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
  ];
  console.log(`\nLIVE mode — chain ${(await provider.getNetwork()).chainId} (G7: tiny balances)`);
  return {
    provider,
    keeper,
    keeperAddress: keeperWallet.address,
    heir: workerEnv.G4_HEIR ?? keeperWallet.address,
    claimDelegate,
    claimAbi: claimArt.abi,
    token: tokenAddr ? new Contract(tokenAddr, erc20Abi, provider) : null,
    canMint: false,
    fundOwner: async () => {}, // live owner is pre-funded by the operator
    anvil: null,
    live: true,
    ownerForHappyPath: owner,
    // live mode reuses the ONE funded owner for every scenario, sequentially
    freshOwner: () => owner,
  };
}

async function main(): Promise<number> {
  const live = Boolean(process.env.G4_RPC_URL);
  if (live) {
    for (const k of ["G4_KEEPER_PRIVATE_KEY", "G4_OWNER_PRIVATE_KEY", "G4_CLAIM_DELEGATE"]) {
      if (!process.env[k]) {
        console.log(`rehearse-g4: G4_RPC_URL is set but ${k} is missing — owner-action:`);
        console.log("  set G4_KEEPER_PRIVATE_KEY / G4_OWNER_PRIVATE_KEY / G4_CLAIM_DELEGATE");
        console.log("  (keeper must be the deployed delegate's immutable keeper)");
        return 0;
      }
    }
  }
  const env = live ? await setupLive() : await setupAnvil();
  const { provider, keeper, heir, claimDelegate, claimAbi } = env;
  const chainId = Number((await provider.getNetwork()).chainId);
  const claimAt = (addr: string) => new Contract(addr, claimAbi, keeper);
  const registerData = (owner: string) =>
    claimAt(claimDelegate).interface.encodeFunctionData("registerHeir", [owner, heir]);

  try {
    console.log(`\ndelegate ${claimDelegate} · keeper ${env.keeperAddress} · heir ${heir}\n`);

    // ---------------- 1. HAPPY PATH (the G4 gate itself) ----------------
    console.log("— happy path: sign → escrow round-trip → Type-4 apply+register → claim");
    const owner1 = env.ownerForHappyPath;
    await env.fundOwner(owner1.address, "0.2");
    if (env.token && env.canMint) {
      await waitReceipt(provider, (await (env.token.connect(keeper) as Contract).mint(owner1.address, 1_500_000n)).hash);
    }
    const nonce1 = await provider.getTransactionCount(owner1.address);
    const auth1 = await owner1.authorize({ address: claimDelegate, nonce: nonce1, chainId });
    const [stored1] = await escrowRoundTrip(owner1.address, [toTuple(auth1)]);
    check("tuple survives the escrow envelope round-trip", stored1!.nonce === nonce1 && stored1!.chainId === chainId);

    // pre-flight the keeper will always run: tuple nonce == live account nonce
    check("pre-flight: tuple nonce matches the live account nonce",
      stored1!.nonce === (await provider.getTransactionCount(owner1.address)));

    const applyTx = await keeper.sendTransaction({
      type: 4, // EXPLICIT — populateTransaction silently picks type 2 otherwise
      to: owner1.address,
      data: registerData(owner1.address),
      authorizationList: [fromTuple(stored1!)],
      gasLimit: 300_000n,
    });
    const applyRcpt = await waitReceipt(provider, applyTx.hash);
    check("Type-4 apply+registerHeir landed (status 1)", applyRcpt.status === 1, applyTx.hash);
    check("getCode(owner) is the 7702 designator for RetenixClaim",
      (await provider.getCode(owner1.address)).toLowerCase() === delegatedCode(claimDelegate));
    const heirOnchain = await (new Contract(owner1.address, claimAbi, provider) as Contract).heirOf(owner1.address);
    check("heirOf(owner) reads the heir AT THE OWNER'S ADDRESS", heirOnchain === heir, String(heirOnchain));

    const tokens = env.token ? [await env.token.getAddress()] : [];
    const heirTokenBefore = env.token ? await env.token.balanceOf(heir) : 0n;
    const heirNativeBefore = await provider.getBalance(heir);
    const ownerNativeBefore = await provider.getBalance(owner1.address);
    const claimTx = await claimAt(owner1.address).claim(owner1.address, tokens, { gasLimit: 300_000n });
    await waitReceipt(provider, claimTx.hash);
    if (env.token) {
      const moved = (await env.token.balanceOf(heir)) - heirTokenBefore;
      check("claim moved the FULL token balance to the heir", moved === 1_500_000n || (env.live && moved > 0n), `${moved}`);
    }
    check("claim swept the native balance to the heir",
      (await provider.getBalance(owner1.address)) === 0n &&
      (await provider.getBalance(heir)) - heirNativeBefore === ownerNativeBefore,
      `${ownerNativeBefore} wei`);

    // ---------------- 2. SELF-INVALIDATION ----------------
    console.log("\n— self-invalidation: nonce bump voids the escrowed tuple (silently!)");
    const owner2 = env.freshOwner();
    if (!env.live) await env.fundOwner(owner2.address, "0.1");
    const nonce2 = await provider.getTransactionCount(owner2.address);
    const auth2 = await owner2.authorize({ address: claimDelegate, nonce: nonce2, chainId });
    const [stored2] = await escrowRoundTrip(owner2.address, [toTuple(auth2)]);

    // the owner "wakes up": ANY transaction bumps the nonce
    await waitReceipt(provider, (await owner2.sendTransaction({ to: owner2.address, value: 0n })).hash);
    check("owner activity bumped the account nonce",
      (await provider.getTransactionCount(owner2.address)) === nonce2 + 1);
    check("pre-flight now catches the stale tuple",
      stored2!.nonce !== (await provider.getTransactionCount(owner2.address)));

    // a keeper that SKIPPED the pre-flight would see this:
    const staleTx = await keeper.sendTransaction({
      type: 4,
      to: owner2.address,
      data: registerData(owner2.address),
      authorizationList: [fromTuple(stored2!)],
      gasLimit: 300_000n,
    });
    const staleRcpt = await waitReceipt(provider, staleTx.hash);
    check("stale Type-4 tx still SUCCEEDS as a transaction (status 1)", staleRcpt.status === 1);
    check("…but the tuple was silently skipped: no code landed on the EOA",
      (await provider.getCode(owner2.address)) === "0x");
    check("…and no HeirRegistered event was emitted", staleRcpt.logs.length === 0);

    // ---------------- 3. REFRESH ----------------
    console.log("\n— refresh: a fresh tuple at the new nonce applies cleanly");
    const nonce2b = await provider.getTransactionCount(owner2.address);
    const auth2b = await owner2.authorize({ address: claimDelegate, nonce: nonce2b, chainId });
    const [stored2b] = await escrowRoundTrip(owner2.address, [toTuple(auth2b)]);
    const freshTx = await keeper.sendTransaction({
      type: 4,
      to: owner2.address,
      data: registerData(owner2.address),
      authorizationList: [fromTuple(stored2b!)],
      gasLimit: 300_000n,
    });
    await waitReceipt(provider, freshTx.hash);
    check("refreshed tuple applied (getCode matches)",
      (await provider.getCode(owner2.address)).toLowerCase() === delegatedCode(claimDelegate));

    // ---------------- 4. RESUME (anvil only — needs a reverting inner call) ----------------
    if (!env.live) {
      console.log("\n— resume: delegation survives a reverted inner call; Type-2 completes it");
      const owner3 = env.freshOwner();
      await env.fundOwner(owner3.address, "0.1");
      const nonce3 = await provider.getTransactionCount(owner3.address);
      const auth3 = await owner3.authorize({ address: claimDelegate, nonce: nonce3, chainId });
      // inner call reverts (ZeroHeir) — the delegation must still apply
      const badData = claimAt(claimDelegate).interface.encodeFunctionData("registerHeir", [
        owner3.address,
        "0x0000000000000000000000000000000000000000",
      ]);
      const revertingTx = await keeper.sendTransaction({
        type: 4,
        to: owner3.address,
        data: badData,
        authorizationList: [auth3],
        gasLimit: 300_000n,
      });
      const revertingRcpt = await waitReceipt(provider, revertingTx.hash);
      check("apply tx reverted (inner ZeroHeir)", revertingRcpt.status === 0);
      check("…but the delegation APPLIED anyway (7702 semantics)",
        (await provider.getCode(owner3.address)).toLowerCase() === delegatedCode(claimDelegate));
      const resumeTx = await keeper.sendTransaction({
        to: owner3.address,
        data: registerData(owner3.address),
        gasLimit: 200_000n,
      });
      await waitReceipt(provider, resumeTx.hash);
      const resumedHeir = await (new Contract(owner3.address, claimAbi, provider) as Contract).heirOf(owner3.address);
      check("plain Type-2 registerHeir completed the resume (no tuple re-burned)", resumedHeir === heir);
    }

    const passed = CHECKS.filter((c) => c.ok).length;
    console.log(`\nGATE G4: PASS — ${passed}/${CHECKS.length} checks (${env.live ? "LIVE" : "anvil prague"})`);
    return 0;
  } finally {
    env.anvil?.kill();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("\nGATE G4: FAIL —", err instanceof Error ? err.message : err);
    console.error("doc 14 fallback (b) applies: owner-online claim simulation with honest labeling.");
    process.exit(1);
  });
