// Reading back the stored draft an activation refers to (doc 10 §Activation
// step 1: "re-validates against the STORED PolicyDraft"). Module 09 persists
// each parsed draft in an `intent.parsed` event keyed by draftId; activation
// re-reads it here so client-edited values re-enter the SAME validation the
// parsed ones did — the client can never widen a bound by editing.
import { events, type Db } from "@retenix/db";
import { and, desc, eq } from "drizzle-orm";
import type { PolicyDraft } from "@retenix/shared";

export interface StoredDraft {
  draftId: string;
  utterance: string;
  draft: PolicyDraft;
  adviceFooter: boolean;
}

/** The draft a user's `intent.parsed` event recorded under `draftId`, or null. */
export async function readStoredDraft(
  db: Db,
  userId: string,
  draftId: string,
): Promise<StoredDraft | null> {
  const rows = await db
    .select({ payloadJson: events.payloadJson })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.type, "intent.parsed")))
    .orderBy(desc(events.createdAt));

  for (const row of rows) {
    const p = row.payloadJson as {
      draftId?: string;
      utterance?: string;
      outcome?: string;
      draft?: PolicyDraft;
      adviceFooter?: boolean;
    };
    if (p.draftId === draftId && p.outcome === "draft" && p.draft) {
      return {
        draftId,
        utterance: p.utterance ?? "",
        draft: p.draft,
        adviceFooter: Boolean(p.adviceFooter),
      };
    }
  }
  return null;
}
