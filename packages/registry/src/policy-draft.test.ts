import { describe, expect, it } from "vitest";
import { REGISTRY_IDS } from "./assets";
import { PolicyDraft } from "./policy-draft";

const brokerWith = (assetId: string) => ({
  broker: {
    cadence: "weekly" as const,
    amountUsd: 25,
    basket: [{ assetId, pct: 100 }],
  },
});

describe("PolicyDraft (registry binding of the tech-spec §8 schema)", () => {
  it("accepts every pinned registry id as a basket asset", () => {
    for (const id of REGISTRY_IDS) {
      expect(PolicyDraft.safeParse(brokerWith(id)).success).toBe(true);
    }
  });

  it.each([["pepe"], ["memecoin"], ["SPYX"], ["spyx "]])(
    "rejects %j — an unlisted asset cannot exist in a valid draft (G11)",
    (id) => {
      expect(PolicyDraft.safeParse(brokerWith(id)).success).toBe(false);
    },
  );

  it("accepts the empty draft {}", () => {
    expect(PolicyDraft.safeParse({}).success).toBe(true);
  });
});
