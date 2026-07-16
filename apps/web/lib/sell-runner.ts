import {
  SUPPORTED_TOKEN_TYPE,
  createSellTransaction,
  createUa,
  magicSigner,
  parseFeeTotals,
  pollToTerminal,
  signAndSend,
  type FeeTotalsUSD,
  type ITradeConfig,
  type MagicSignerClient,
  type UniversalAccount,
} from "@retenix/ua";
import { clientEnv } from "@/env";
import { magic } from "@/lib/magic";
import { signEnvelope } from "@/lib/sign";
import { trpcVanilla } from "@/lib/trpc-vanilla";

/*
 * The sell-from-detail runner (doc 12, PROPOSED; flag-gated) — a single-leg
 * cousin of lib/sweep-runner.ts. Same laws: the user's ONE visible act is
 * the ConfirmSheet tap; the UA root hash and the recordSell envelope are
 * headless personal_signs (G5); create → sign → send is one continuous flow
 * because quotes expire (doc 03 — Solana windows are ~1 minute, so the
 * confirm-time quote is FRESH, never the preview's); sells settle ONLY into
 * USDC in the user's own balance (doc 06 hard constraint).
 */

const SELL_TO_USDC: ITradeConfig = {
  usePrimaryTokens: [SUPPORTED_TOKEN_TYPE.USDC],
};

/** Client-side settlement polling; the server re-verifies with its own poll. */
const SETTLE_POLL = { intervalMs: 2000, timeoutMs: 120_000 };

const REPORT_ATTEMPTS = 3;
const REPORT_BACKOFF_MS = [1_000, 3_000];

export interface SellTarget {
  assetId: string;
  chainId: number;
  address: string;
  /** Exact human quantity (RPC uiAmountString) — sell-all never floats. */
  qtyHuman: string;
}

function browserUa(eoa: string): UniversalAccount {
  return createUa({
    ownerAddress: eoa,
    credentials: {
      projectId: clientEnv.NEXT_PUBLIC_PARTICLE_PROJECT_ID,
      projectClientKey: clientEnv.NEXT_PUBLIC_PARTICLE_CLIENT_KEY,
      projectAppUuid: clientEnv.NEXT_PUBLIC_PARTICLE_APP_UUID,
    },
  });
}

/** Advisory fee preview for the ConfirmSheet — a fresh quote is taken again
 *  at confirm time (this one may expire while the sheet is open). */
export async function quoteSellFees(
  eoa: string,
  target: SellTarget,
): Promise<FeeTotalsUSD> {
  const tx = await createSellTransaction(
    browserUa(eoa),
    {
      token: { chainId: target.chainId, address: target.address },
      amount: target.qtyHuman,
    },
    SELL_TO_USDC,
  );
  return parseFeeTotals(tx);
}

export type SellRunResult =
  | { kind: "sold"; receipt: string }
  | { kind: "failed"; message: string };

/** The confirm-time flow: fresh quote → sign → send → settle → signed report. */
export async function runSell(
  eoa: string,
  target: SellTarget,
): Promise<SellRunResult> {
  const ua = browserUa(eoa);
  const signer = magicSigner(magic as unknown as MagicSignerClient, eoa);

  let transactionId: string;
  try {
    const tx = await createSellTransaction(
      ua,
      {
        token: { chainId: target.chainId, address: target.address },
        amount: target.qtyHuman,
      },
      SELL_TO_USDC,
    );
    ({ transactionId } = await signAndSend(ua, tx, signer));
  } catch (err) {
    return { kind: "failed", message: errorMessage(err) };
  }

  // Settlement (client view) — the server's own poll is the authority.
  try {
    const settled = await pollToTerminal(ua, transactionId, SETTLE_POLL);
    if (settled.outcome === "refunded") {
      return {
        kind: "failed",
        message: "the sale didn't complete — everything stayed put",
      };
    }
  } catch {
    // Lookup trouble is not failure — the report below lets the server decide.
  }

  // Signed report, fresh envelope per attempt (nonces are single-use).
  const payload = { assetId: target.assetId, transactionId };
  let lastError = "the sale report didn't reach the server";
  for (let attempt = 0; attempt < REPORT_ATTEMPTS; attempt += 1) {
    try {
      const envelope = await signEnvelope("portfolio.recordSell", payload, eoa);
      const res = await trpcVanilla.portfolio.recordSell.mutate(envelope);
      return { kind: "sold", receipt: res.receipt };
    } catch (err) {
      lastError = errorMessage(err);
      const backoff = REPORT_BACKOFF_MS[attempt];
      if (backoff !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
  return { kind: "failed", message: lastError };
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
