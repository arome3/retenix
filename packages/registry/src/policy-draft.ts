// The tech-spec §8 PolicyDraft schema bound to the pinned registry:
//
//   const PolicyDraft = z.object({ … assetId: z.enum(REGISTRY_IDS) … });
//
// The schema BODY lives once in @retenix/shared (policyDraftFor — see the
// cycle note there: registry depends on shared, so shared cannot import
// REGISTRY_IDS); this file is the spec's concrete binding over the full
// registry tuple. intent.parse never uses this directly — the route builds
// the region-narrowed variant per request — but doc 10's cards and any
// full-universe validation key off this export.
import { policyDraftFor } from "@retenix/shared";
import { REGISTRY_IDS } from "./assets";

export const PolicyDraft = policyDraftFor(REGISTRY_IDS);
