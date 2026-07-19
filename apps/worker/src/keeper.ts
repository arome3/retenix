// Estate keeper (doc 14): watches for Claimable estates → sends the heir
// email (token-gated link) → on heir readiness (estate.claim_requested from
// the web) runs the claim sequence. Also fires due deadlines — fireDeadline
// is PERMISSIONLESS by design (CONFLICTS #12: Chainlink Automation is the
// GUARANTEED path once the upkeep is registered; this is a liveness belt for
// the pre-registration demo window, flagged in the HANDOFF; G9's split is
// preserved — the deadline never DEPENDS on this cron).
//
// Safety rails, restated where they bind (TS-14.3 / tech spec §10):
// - decrypt happens HERE only, and the decrypted email+salt must hash to the
//   ONCHAIN beneficiaryHash (the revealed match) before any email or claim;
// - markClaimed is the single global commit point: nothing irreversible
//   happens on any chain before it, and its onchain gate (Claimable +
//   claimReadyAt passed) is what bounds a malicious keeper;
// - a claim NEVER runs before claimReadyAt (the contract enforces it); a
//   tuple is NEVER applied while status ∉ {Claimable, Claimed} (this module
//   only reaches the sequence through those states).
import {
  CLAIM_TOKEN_TTL_MS,
  ESTATE_EVENTS,
  beneficiaryHashFor,
  estateClaimedReceipt,
  estateStatusName,
  mintClaimToken,
  type ClaimChainProgress,
  type EscrowTuple,
} from "@retenix/shared";
import type { EscrowKeyProvider } from "@retenix/shared/escrow";
import type { Db } from "@retenix/db";
import { sha256, toUtf8Bytes, type Signer } from "ethers";

import { env } from "../env";
import { captureError, keeperDeadlineFired, recordEvent, slack } from "./notify";
import { claimOnChain, makeClaimChainIo, type ClaimChainIo } from "./estate-claim";
import { scanEstate, defaultScanDeps, type ChainScan, type EstateScanDeps } from "./estate-scan";
import {
  decryptBeneficiarySecret,
  decryptTupleSet,
  enrolledEstates,
  latestEvent,
  sendClaimEmail,
  type EnrolledEstate,
  type EstateOnchain,
} from "./estate-support";

export const KEEPER_CRON_PROD = "*/2 * * * *";
export const KEEPER_CRON_DEMO = "*/15 * * * * *";

const ESTATE_CHAINS = [1, 56, 8453, 196, 42161] as const;

export interface KeeperDeps {
  db: Db;
  onchain: EstateOnchain;
  escrow: EscrowKeyProvider;
  scan: EstateScanDeps;
  /** Per-chain claim I/O — production binds the keeper signer per chain. */
  chainIo: (chainId: number) => ClaimChainIo;
  now?: () => number;
}

export function productionChainIo(keeperSigner: Signer): (chainId: number) => ClaimChainIo {
  const memo = new Map<number, ClaimChainIo>();
  return (chainId) => {
    let io = memo.get(chainId);
    if (!io) {
      io = makeClaimChainIo(chainId, keeperSigner);
      memo.set(chainId, io);
    }
    return io;
  };
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------
export async function keeperTick(deps: KeeperDeps): Promise<void> {
  let rows: EnrolledEstate[];
  try {
    rows = await enrolledEstates(deps.db);
  } catch (err) {
    captureError(err, { while: "keeper-scan" });
    return;
  }
  for (const estate of rows) {
    try {
      await keeperStep(deps, estate);
    } catch (err) {
      captureError(err, { while: "keeper-estate", owner: estate.owner });
    }
  }
}

async function keeperStep(deps: KeeperDeps, estate: EnrolledEstate): Promise<void> {
  const now = deps.now ? deps.now() : Date.now();
  const chain = await deps.onchain.estateOf(estate.owner);
  const status = estateStatusName(chain.status);

  // (a) due deadline → fire (permissionless liveness belt; see header)
  if (
    status === "enrolled" &&
    chain.lastCheckIn !== 0n &&
    now / 1000 > Number(chain.lastCheckIn + chain.inactivitySecs)
  ) {
    try {
      const { txHash } = await deps.onchain.fireDeadline(estate.owner);
      console.log(`[keeper] fireDeadline(${estate.owner}) → ${txHash}`);
      // doc 17 trigger 4a. A console.log is invisible in production, and this
      // is the moment the challenge window opens — ops must know before the
      // heir does, while the owner can still cancel.
      await keeperDeadlineFired(estate.owner, txHash);
    } catch (err) {
      // Chainlink (or anyone) may have fired it first — re-read next tick
      captureError(err, { while: "keeper-fire-deadline", owner: estate.owner });
    }
    return;
  }

  if (status !== "claimable" && status !== "claimed") return;

  // (b) Claimable and no live claim email → decrypt, verify, enumerate, email
  if (status === "claimable") {
    const sent = await latestEvent(deps.db, estate.userId, [ESTATE_EVENTS.claimEmailSent]);
    const sentPayload = sent?.payload as { expiresAt?: string } | undefined;
    const live =
      sent !== null &&
      typeof sentPayload?.expiresAt === "string" &&
      Date.parse(sentPayload.expiresAt) > now;
    if (!live) {
      await sendHeirEmail(deps, estate, chain.beneficiaryHash);
    }
  }

  // (c) heir readiness → run the claim sequence
  const requested = await latestEvent(deps.db, estate.userId, [ESTATE_EVENTS.claimRequested]);
  if (!requested) return;
  const done = await latestEvent(deps.db, estate.userId, [ESTATE_EVENTS.claimed]);
  if (done && done.at.getTime() > requested.at.getTime()) return;
  const heirEoa = (requested.payload as { heirEoa?: string } | null)?.heirEoa;
  if (!heirEoa) return;
  await runClaimSequence(deps, estate, heirEoa);
}

// ---------------------------------------------------------------------------
// (b) the heir email
// ---------------------------------------------------------------------------
async function sendHeirEmail(
  deps: KeeperDeps,
  estate: EnrolledEstate,
  onchainBeneficiaryHash: string,
): Promise<void> {
  const secret = await decryptBeneficiarySecret(
    deps.escrow,
    estate.owner,
    estate.beneficiaryEmailEnc,
  );
  // the revealed match — refuse to email anyone the onchain commitment
  // doesn't name (a DB/enroll mismatch is a support case, never a send)
  if (beneficiaryHashFor(secret.email, secret.salt) !== onchainBeneficiaryHash) {
    captureError(new Error("beneficiary secret does not match the onchain hash"), {
      while: "keeper-email",
      owner: estate.owner,
    });
    await slack(`estate ${estate.owner}: beneficiary hash mismatch — claim email NOT sent`);
    return;
  }

  const { summary } = await scanEstate(deps.scan, estate.owner);
  const { token, tokenHash } = mintClaimToken();
  const expiresAt = new Date((deps.now ? deps.now() : Date.now()) + CLAIM_TOKEN_TTL_MS);

  // the token store (hash ONLY) + everything S6's claimInfo needs — written
  // BEFORE the send so a crash never leaves a live token unrecorded
  await recordEvent(deps.db, ESTATE_EVENTS.claimEmailSent, estate.userId, {
    tokenHash,
    expiresAt: expiresAt.toISOString(),
    summary,
    ownerName: secret.ownerName ?? null,
    beneficiaryEmailHash: sha256(toUtf8Bytes(secret.email.trim().toLowerCase())),
  });

  const link = `${env.APP_BASE_URL}/claim/${token}`;
  await sendClaimEmail({
    to: secret.email,
    link,
    ownerName: secret.ownerName ?? null,
    summary,
  });
}

// ---------------------------------------------------------------------------
// (c) the claim sequence — markClaimed first (the commit point), then the 5
// chains, continue-and-report; each chain's terminal state is an
// estate.claim_progress event S6 polls.
// ---------------------------------------------------------------------------
export async function runClaimSequence(
  deps: KeeperDeps,
  estate: EnrolledEstate,
  heirEoa: string,
): Promise<void> {
  // integrity: the decrypted secret must still hash to the onchain commitment
  const chainState = await deps.onchain.estateOf(estate.owner);
  const secret = await decryptBeneficiarySecret(
    deps.escrow,
    estate.owner,
    estate.beneficiaryEmailEnc,
  );
  if (beneficiaryHashFor(secret.email, secret.salt) !== chainState.beneficiaryHash) {
    captureError(new Error("beneficiary secret does not match the onchain hash"), {
      while: "keeper-claim",
      owner: estate.owner,
    });
    return;
  }

  // markClaimed — the single global commit point
  const status = estateStatusName(chainState.status);
  if (status === "claimable") {
    await deps.onchain.markClaimed(estate.owner, heirEoa);
  } else if (status === "claimed") {
    // crash-resume: the commit already landed — the recorded heir must match
    const committed = await deps.onchain.claimedHeir(estate.owner);
    if (committed && committed.toLowerCase() !== heirEoa.toLowerCase()) {
      captureError(new Error("claim resume: committed heir differs — manual support case"), {
        while: "keeper-claim",
        owner: estate.owner,
      });
      await slack(`estate ${estate.owner}: committed heir ≠ requested heir — claim HALTED`);
      return;
    }
  } else {
    // not claimable (owner cancelled / checked in) — a hijack path must
    // never survive an owner check-in; do nothing
    return;
  }

  // decrypt the escrowed tuples ONCE (TS-14.3: ciphertext at rest, plaintext
  // only inside this keeper path)
  let tuples: EscrowTuple[] = [];
  if (estate.tuplesEnc) {
    try {
      tuples = await decryptTupleSet(deps.escrow, estate.owner, estate.tuplesEnc);
    } catch (err) {
      captureError(err, { while: "keeper-tuples", owner: estate.owner });
    }
  }

  // fresh per-chain scans (balances move; the email-time summary is stale)
  let scans: ChainScan[] = [];
  try {
    ({ perChain: scans } = await scanEstate(deps.scan, estate.owner));
  } catch (err) {
    captureError(err, { while: "keeper-claim-scan", owner: estate.owner });
  }

  const results: ClaimChainProgress[] = [];
  for (const chainId of ESTATE_CHAINS) {
    const progress = await claimOnChain({
      io: deps.chainIo(chainId),
      chainId,
      owner: estate.owner,
      heir: heirEoa,
      tuple: tuples.find((t) => t.chainId === chainId) ?? null,
      scan: scans.find((s) => s.chainId === chainId) ?? null,
    });
    results.push(progress);
    // one progress event per chain terminal state — S6 renders these live
    await recordEvent(deps.db, ESTATE_EVENTS.claimProgress, estate.userId, progress);
  }

  const claimedChains = results.filter((r) => r.state === "claimed");
  await recordEvent(deps.db, ESTATE_EVENTS.claimed, estate.userId, {
    kind: "legacy",
    receipt: estateClaimedReceipt(claimedChains.length),
    sourceCount: claimedChains.length,
    heirEoa,
    results,
  });
  await slack(
    `estate ${estate.owner} claimed → ${heirEoa}: ${claimedChains.length}/${ESTATE_CHAINS.length} networks (${results
      .map((r) => `${r.network}:${r.state}`)
      .join(", ")})`,
  );
}

export function defaultKeeperDeps(db: Db, onchain: EstateOnchain, escrow: EscrowKeyProvider, keeperSigner: Signer): KeeperDeps {
  return {
    db,
    onchain,
    escrow,
    scan: defaultScanDeps(),
    chainIo: productionChainIo(keeperSigner),
  };
}
