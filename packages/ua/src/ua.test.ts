import {
  UniversalAccount,
  UNIVERSAL_ACCOUNT_VERSION,
  type IUniversalAccountConfig,
} from "@particle-network/universal-account-sdk";
import { describe, expect, it } from "vitest";
import { createUa, type ParticleCreds } from "./ua";

const CREDS: ParticleCreds = {
  projectId: "proj",
  projectClientKey: "clientKey",
  projectAppUuid: "appUuid",
};
const EOA = "0x1234567890123456789012345678901234567890";

// White-box read of the SDK's `private smartAccountOptions` / `private tradeConfig`.
// TS `private` is not enforced at runtime; this documents init behaviour and the G2
// trap without a network call (the constructor makes none).
type Inner = {
  smartAccountOptions: {
    name: string;
    version: string;
    ownerAddress: string;
    useEIP7702?: boolean;
  };
  tradeConfig: Record<string, unknown>;
};
const inner = (ua: UniversalAccount) => ua as unknown as Inner;

describe("createUa", () => {
  it("puts ownerAddress INSIDE smartAccountOptions (G2)", () => {
    const opts = inner(createUa({ ownerAddress: EOA, credentials: CREDS }))
      .smartAccountOptions;
    expect(opts.ownerAddress).toBe(EOA);
  });

  it("initializes UNIVERSAL / useEIP7702 / version = UNIVERSAL_ACCOUNT_VERSION (2.0.1)", () => {
    const opts = inner(createUa({ ownerAddress: EOA, credentials: CREDS }))
      .smartAccountOptions;
    expect(opts.name).toBe("UNIVERSAL");
    expect(opts.useEIP7702).toBe(true);
    // The V2 *contract* version constant — NOT the 2.0.3 package pin. Never a literal.
    expect(opts.version).toBe(UNIVERSAL_ACCOUNT_VERSION);
    expect(UNIVERSAL_ACCOUNT_VERSION).toBe("2.0.1");
  });

  it("sets slippageBps 100 and never passes universalGas (removed in v2)", () => {
    const trade = inner(createUa({ ownerAddress: EOA, credentials: CREDS }))
      .tradeConfig;
    expect(trade.slippageBps).toBe(100);
    expect(trade).not.toHaveProperty("universalGas");
  });

  it("fails fast on an invalid ownerAddress", () => {
    expect(() => createUa({ ownerAddress: "", credentials: CREDS })).toThrow();
    expect(() =>
      createUa({ ownerAddress: "not-an-address", credentials: CREDS }),
    ).toThrow();
  });

  it("fails fast on missing credentials", () => {
    expect(() =>
      createUa({
        ownerAddress: EOA,
        credentials: { ...CREDS, projectClientKey: "" },
      }),
    ).toThrow(/credentials/);
  });
});

describe("G2 regression guard — ownerAddress must NOT be top-level", () => {
  it("is a TYPE error to pass ownerAddress at the config top level (excess property)", () => {
    // smartAccountOptions is otherwise valid, so the ONLY error is the excess
    // top-level ownerAddress — which the v2.0.3 config type does not declare (G2).
    new UniversalAccount({
      projectId: "p",
      projectClientKey: "k",
      projectAppUuid: "u",
      // @ts-expect-error top-level ownerAddress is not part of IUniversalAccountConfig
      // (v2.0.3 breaking change). Stale online examples put it here.
      ownerAddress: EOA,
      smartAccountOptions: {
        name: "UNIVERSAL",
        version: UNIVERSAL_ACCOUNT_VERSION,
        ownerAddress: EOA, // the correct home
        useEIP7702: true,
      },
    });
  });

  it("is silently IGNORED at runtime — a top-level owner leaves the UA owner empty", () => {
    // Cast past the types (excess-property checks only fire on fresh literals) to
    // reproduce the stale-example mistake and observe the SDK's real behaviour: it
    // never reads a top-level ownerAddress, so smartAccountOptions.ownerAddress
    // defaults to "" — a UA bound to the WRONG (empty) owner, silently.
    const wrong = {
      projectId: "p",
      projectClientKey: "k",
      projectAppUuid: "u",
      ownerAddress: EOA, // top-level — the mistake
      smartAccountOptions: {
        name: "UNIVERSAL",
        version: UNIVERSAL_ACCOUNT_VERSION,
        useEIP7702: true,
      },
    } as unknown as IUniversalAccountConfig;
    const ua = new UniversalAccount(wrong);
    expect(inner(ua).smartAccountOptions.ownerAddress).toBe("");
    expect(inner(ua).smartAccountOptions.ownerAddress).not.toBe(EOA);
  });
});
