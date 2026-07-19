// Alchemy Address Activity receiver (doc 14, tech spec §9): UX notifications
// ONLY — "we noticed activity" — and an optional immediate heartbeat
// observation for the matched owner. The webhook NEVER bumps the timer: a
// check-in relays only after heartbeat.ts confirms the activity through its
// own observation (CONFLICTS #13's provenance discipline; a spoofed webhook
// that somehow passed the HMAC could at worst trigger an observation that
// finds nothing).
//
// Signature: Alchemy signs the RAW request body with the app's signing key —
// X-Alchemy-Signature = hex(HMAC-SHA256(body, ALCHEMY_WEBHOOK_SIGNING_KEY)).
// Ops (webhook creation on the 5 EVM chains for enrolled owners) is doc 17's;
// the endpoint is live either way.
import { createHmac, timingSafeEqual } from "node:crypto";
import { ESTATE_EVENTS, estateActivityNoticedReceipt, NETWORK_NAMES } from "@retenix/shared";
import { type Db } from "@retenix/db";

import { env } from "../env";
import { captureError, recordEvent } from "./notify";
import { enrolledEstates, type EnrolledEstate } from "./estate-support";

export function verifyAlchemySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", env.ALCHEMY_WEBHOOK_SIGNING_KEY)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim().toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Alchemy network slug → the display name receipts may use. */
export function networkFromSlug(slug: string | undefined): string {
  const byId: Record<string, number> = {
    ETH_MAINNET: 1,
    BNB_MAINNET: 56,
    BASE_MAINNET: 8453,
    ARB_MAINNET: 42161,
  };
  const chainId = slug ? byId[slug.toUpperCase()] : undefined;
  return (chainId && NETWORK_NAMES[chainId]) || "one of your sources";
}

interface AddressActivityBody {
  event?: {
    network?: string;
    activity?: { fromAddress?: string; toAddress?: string }[];
  };
}

export interface WebhookDeps {
  db: Db;
  /** Optional immediate observation trigger (heartbeat.observeOwner bound at
   *  boot) — UX freshness; absent in degraded boots. */
  observe?: (estate: EnrolledEstate) => Promise<unknown>;
}

/**
 * Handle a VERIFIED Address Activity payload: match touched addresses to
 * enrolled owners → write the notification event (UX row, never the timer) →
 * kick an immediate observation so a real bump lands within seconds instead
 * of a cron interval.
 */
export async function handleAddressActivity(deps: WebhookDeps, body: unknown): Promise<{ matched: number }> {
  const parsed = body as AddressActivityBody | null;
  const activity = parsed?.event?.activity ?? [];
  if (activity.length === 0) return { matched: 0 };

  const touched = new Set<string>();
  for (const a of activity) {
    if (typeof a.fromAddress === "string") touched.add(a.fromAddress.toLowerCase());
    if (typeof a.toAddress === "string") touched.add(a.toAddress.toLowerCase());
  }

  let rows: EnrolledEstate[];
  try {
    rows = await enrolledEstates(deps.db);
  } catch (err) {
    captureError(err, { while: "webhook-scan" });
    return { matched: 0 };
  }

  const network = networkFromSlug(parsed?.event?.network);
  let matched = 0;
  for (const estate of rows) {
    if (!touched.has(estate.owner.toLowerCase())) continue;
    matched += 1;
    await recordEvent(deps.db, ESTATE_EVENTS.activityNoticed, estate.userId, {
      kind: "legacy",
      receipt: estateActivityNoticedReceipt(network),
      network,
    });
    if (deps.observe) {
      // fire-and-forget — freshness, not correctness
      void deps.observe(estate).catch((err: unknown) => {
        captureError(err, { while: "webhook-observe", owner: estate.owner });
      });
    }
  }
  return { matched };
}
