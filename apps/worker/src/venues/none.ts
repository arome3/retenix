// The null hedge venue (doc 19) — THIS IS WHAT SHIPS TODAY.
//
// Gate G-H1 failed: Ostium was drained on 2026-07-15 and its Trading contract
// reads isPaused() = true AND isDone() = true on Arbitrum One. `isDone` is the
// Gains-fork decommission flag, so the venue is not coming back at that
// address and pinning it would violate the same G11 discipline the registry
// applies to mints. gTrade is live but unexercised by us. So the venue that
// ships is NO venue, and every hedge path degrades honestly through it.
//
// This is not a stub in the pejorative sense — it is the correct implementation
// of "there is no venue". Every method answers, none throws, and the answer is
// always the same honest one, which is exactly what the rest of the system
// needs in order to keep working.
import {
  venueUnavailable,
  type HedgeVenue,
  type OpenQuote,
  type VenueOutcome,
  type VenuePosition,
  type VenueTransaction,
} from "@retenix/shared";

const ARBITRUM_ONE = 42161;

/** `retryAfterMs: null` — retrying cannot help; a venue must be chosen first. */
const unset = <T>() =>
  venueUnavailable<T>(
    "not-configured",
    null,
    "no hedge venue is configured (HEDGE_ENABLED=0 or no venue pinned)",
  );

export const noneVenue: HedgeVenue = {
  id: "none",
  chainId: ARBITRUM_ONE,

  // Reports unavailable rather than `{ paused: true }`: "paused" would imply a
  // venue exists and might resume, which would be a lie the kill switch could
  // act on. The kill path reads this and skips its close stage entirely.
  health(): Promise<VenueOutcome<{ paused: boolean }>> {
    return Promise.resolve(unset<{ paused: boolean }>());
  },

  // No venue means no pair, for any asset — never a guess.
  pairFor(): string | null {
    return null;
  },

  quoteOpen(): Promise<VenueOutcome<OpenQuote>> {
    return Promise.resolve(unset<OpenQuote>());
  },

  buildOpen(): Promise<VenueOutcome<{ transactions: VenueTransaction[]; expectUsdc: number }>> {
    return Promise.resolve(unset<{ transactions: VenueTransaction[]; expectUsdc: number }>());
  },

  buildClose(): Promise<VenueOutcome<{ transactions: VenueTransaction[] }>> {
    return Promise.resolve(unset<{ transactions: VenueTransaction[] }>());
  },

  // null would mean "no position, venue checked". Unavailable means "we do not
  // know", and the caller must not conclude the user is unhedged from it.
  readPosition(): Promise<VenueOutcome<VenuePosition | null>> {
    return Promise.resolve(unset<VenuePosition | null>());
  },

  queueLimitOpen(): Promise<VenueOutcome<{ venueOrderId: string }>> {
    return Promise.resolve(unset<{ venueOrderId: string }>());
  },
};
