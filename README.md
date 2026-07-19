# Retenix

**The self-custodial brokerage that runs itself.** — Arnen Labs, UXmaxx hackathon build.

An AI broker that invests your entire cross-chain balance, a guardian that enforces your limits
onchain, and a continuity agent that knows how to end things — kill switch, stop-loss, or
inheritance. Your own address, your own keys, exportable at any time.

The assets live on Solana. The money sits on EVM chains. Every incumbent makes you cross that gap
yourself; Retenix dissolves it — one balance across **six networks** (Ethereum, Base, Arbitrum, BSC,
X Layer, Solana), and a policy you can read.

---

## What each SDK is actually load-bearing for

Nothing here is decorative. Each dependency owns a flow the product cannot ship without.

| SDK / tool | Version | The flow it carries |
|---|---|---|
| [`magic-sdk`](https://docs.magic.link/) | **33.9.0** (exact) | Email-OTP onboarding and the user's own EOA — then **headless** signing: `personal_sign` for the UA root hash and `sign7702Authorization` for the EIP-7702 tuple, both without a wallet popup. Key export is what makes "self-custodial" a claim you can check. |
| [`@particle-network/universal-account-sdk`](https://developers.particle.network/) | **2.0.3** (exact) | The unified balance across all six networks, and every movement of value — buys, sells, converts, transfers — routed and settled cross-chain. Runs in **7702 mode**, so the account is the user's existing address, upgraded in place. |
| [`ai`](https://ai-sdk.dev/) + `@ai-sdk/anthropic` | **7.x** | Plain-English intent → a typed `PolicyDraft`. The model proposes; it never executes. Its output is a schema, and the schema is the wall. |
| Foundry / Solidity | 0.8.26 | `RetenixPolicy` and `RetenixClaim` on Arbitrum One — per-execution and per-period caps, asset allowlists, one-transaction revoke, and the estate state machine. The guardrails are onchain, so they hold whether or not our servers do. |
| [Chainlink Automation](https://docs.chain.link/chainlink-automation) | Arbitrum One | The inactivity deadline. It has to fire even if every Retenix server is dark — which is the entire point of an inheritance feature, so it does not run on our cron. |

**Where the money actually moves:** a policy is authored in the UI, signed once by the user, and
written onchain. From then on the worker quotes, checks the contract, records the execution onchain,
sends through Particle, and writes a receipt. An out-of-policy attempt reverts **at the contract** —
and that revert becomes a receipt too, rendered proudly, because it is the product working.

## Deployed and verified

| Contract | Network | Address |
|---|---|---|
| `RetenixPolicy` | Arbitrum One | [`0x606cDade…6024`](https://arbiscan.io/address/0x606cdadeeb7ff1e3d86c92e34b2e24dc9e9c6024#code) |
| `RetenixClaim` | Arbitrum One | [`0x92427d60…D8d0`](https://arbiscan.io/address/0x92427d60cda5f63740d95ad972dfa5a115add8d0#code) |
| `RetenixHedge` | Arbitrum One | [`0x26631E40…A2e1`](https://arbiscan.io/address/0x26631e4088658c691aef560313ee7564a1cfa2e1#code) |

Source-verified via Etherscan API V2. Full deployment record, including the Sepolia dress rehearsal
where every guardrail was proven to revert onchain: [`docs/deployments.md`](docs/deployments.md).

## Bounty writeups

- [Universal Accounts / EIP-7702](docs/writeup-ua-track.md) — four load-bearing 7702 usages
- [Arbitrum](docs/writeup-arbitrum.md) — why it is the settlement home, and the verified contracts
- [Magic](docs/writeup-magic.md) — the trust anchor, from OTP to key export

---

## Run it yourself

Prerequisites: **Node 22** (`.nvmrc`), **pnpm 9** (`corepack enable`), a reachable **Postgres**, and
[Foundry](https://book.getfoundry.sh/) if you want to run the contract tests.

```bash
git clone https://github.com/arome3/retenix.git && cd retenix
pnpm i

cp .env.example .env                              # tooling (drizzle-kit, db tests)
cp apps/web/.env.example apps/web/.env.local      # web
cp apps/worker/.env.example apps/worker/.env      # worker
# Set DATABASE_URL in all three. Everything else can stay a placeholder —
# the app boots, the UI works, and the tests pass without a single credential.

pnpm db:push   # create the schema
pnpm dev       # web on :3000 + worker, concurrently
```

Open <http://localhost:3000>. `DEMO_MODE=1` in `apps/web/.env.local` opens the eligibility gate
without a real region.

**What works on placeholders, and what does not.** Placeholder credentials are a first-class path,
not an accident: the whole test suite, the golden-path walk, and both apps' boots are green without
any account anywhere. What needs real credentials is anything that touches someone else's
infrastructure — Magic (login), Particle (quotes and settlement), Anthropic (intent parsing), and an
RPC provider. The worker says so at boot rather than failing mysteriously later.

### Checks

```bash
pnpm test              # 1160 unit tests across apps and packages
pnpm typecheck         # tsc -b + the Next app
pnpm lint              # eslint, including the no-process.env rule
pnpm e2e               # Playwright — `e2e/golden-path.spec.ts` walks all 7 demo beats
pnpm contrast          # every token pair against WCAG 2.2 AA
pnpm copy-canon        # banned vocabulary in user-facing copy is a release blocker
pnpm check:pins        # the two exact SDK pins
cd contracts && forge test   # 124 tests
```

## Layout

```
apps/web        Next.js 16 (App Router) — UI + the tRPC API
apps/worker     the agent service: cron scheduler, pg-boss queue, execution pipeline
packages/ua     the ONLY code that touches the Particle SDK
packages/db     Drizzle schema + client
packages/registry  the pinned asset registry (mints are verified, never guessed)
packages/shared    money helpers, receipt templates, signing envelopes
contracts       Foundry — RetenixPolicy, RetenixClaim, RetenixHedge
e2e             Playwright over the demo beats
```

Two dependencies are pinned **exactly** and must not move: `@particle-network/universal-account-sdk`
at 2.0.3 and `magic-sdk` at 33.9.0. CI fails on drift, a bot is configured to ignore them, and a
daily $1 mainnet convert runs as the tripwire.

## License

Unlicensed hackathon build. Not investment advice; tokenized equities are not shares.
