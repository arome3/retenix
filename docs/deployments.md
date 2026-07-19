# Deployments

Record of every contract deployment (doc 07 §Deployment). Local-only file
(docs/ is gitignored — owner decision 2026-07-10); the runtime source of truth
is the env (`POLICY_CONTRACT_ADDRESS`) and the typed record is
`packages/shared/src/contracts.ts`.

## RetenixPolicy

| Network | Chain ID | Address | Verified | Deployed | Constructor (agent / keeper / relayer / challengeWindowSecs) | Notes |
|---|---|---|---|---|---|---|
| Arbitrum Sepolia | 421614 | `0x4549a91b4727537372925C8C589d9BCfF9B6c261` | ✓ [source](https://sepolia.arbiscan.io/address/0x4549a91b4727537372925c8c589d9bcff9b6c261#code) | 2026-07-13, [tx](https://sepolia.arbiscan.io/tx/0x1a1e18601316415fb5bb3870aa542dd67f1225276f2aaa0c4399557841289792) (4,197,683 gas) | all roles = deployer `0x562937835cdD5C92F54B94Df658Fd3b50A68ecD5`; window 60 | dress rehearsal run — transcript below |
| Arbitrum One | 42161 | `0x606cDadeeb7FF1e3d86C92e34b2e24dC9E9C6024` | ✓ [source](https://arbiscan.io/address/0x606cdadeeb7ff1e3d86c92e34b2e24dc9e9c6024#code) | 2026-07-13, [tx](https://arbiscan.io/tx/0x9f2d1a5da0444855f1535efb84c5d332e0157d147dece80bf4d3960c38127a39) (4,048,568 gas @ 0.0201 gwei = 0.0000815 ETH ≈ $0.28) | all roles = deployer `0x562937835cdD5C92F54B94Df658Fd3b50A68ecD5` (DEV agent — module 08 redeploys if KMS differs); window 60 | recorded in worker `POLICY_CONTRACT_ADDRESS` + `contracts.ts` |

## RetenixHedge (doc 19 — Guardian Hedge caps; the RetenixPolicy COMPANION, decision D-H1)

Companion, not an extension: RetenixPolicy is frozen on One, `RetenixClaim.sol:52`
holds its address `immutable`, and `plans.contract_plan_id` carries no chain
column — redeploying the policy would strand enrolled estates and silently
collide plan ids. **Own `authNonces` space:** relay helpers must read hedge
nonces from THIS address, not from `POLICY_CONTRACT_ADDRESS`, or every hedge
mutation reverts `BadNonce`.

| Network | Chain ID | Address | Verified | Deployed | Constructor (agent / attestationMaxAgeSecs) | Notes |
|---|---|---|---|---|---|---|
| Arbitrum Sepolia | 421614 | `0x1D10bfed9Ba684ce841016EEbAe6dAD0c54C28eE` | ✓ [source](https://sepolia.arbiscan.io/address/0x1d10bfed9ba684ce841016eebae6dad0c54c28ee#code) | 2026-07-18 (2,370,113 gas) | agent = deployer `0x5629…ecD5` / 900 | Sepolia-first per doc 19 step 3 |
| Arbitrum One | 42161 | `0x26631E4088658c691AEf560313eE7564a1cfA2e1` | ✓ [source](https://arbiscan.io/address/0x26631e4088658c691aef560313ee7564a1cfa2e1#code) | 2026-07-18, [tx](https://arbiscan.io/tx/0x1a297a1ef1c4ece8bd7ce1aad7d1e4d3d1b376d87a5deda27920933bb253cd9e) (2,239,005 gas @ 0.0201 gwei = 0.0000451 ETH ≈ $0.16) | agent = deployer `0x5629…ecD5` (DEV — immutable; KMS agent ⇒ redeploy) / 900 | recorded in `contracts.ts`; worker env `HEDGE_CONTRACT_ADDRESS` |

**Deploy gotcha (cost us two failed attempts, no funds lost):** forge estimates an
EIP-1559 max-fee at ~2× base (0.040 gwei) while Arbitrum's actual price was
0.0200, which put the *buffer* — not the real cost — above the deployer's
balance. Arbitrum's base fee floors at 0.01 gwei, so
`--legacy --with-gas-price 25000000` sends at a real premium and succeeded.
Actual spend was 0.0000451 ETH against a 0.0001 ETH balance.

**The hedge caps, stated honestly.** `maxNotionalUsd6` is owner-signed at plan
creation and immutable for the plan's life — a compromised agent cannot raise
it. Per open the agent additionally attests the holding's value, and the
contract enforces `notional ≤ min(ceiling, attested)` with freshness guards.
"≤ holding value" is therefore an **auditable honest-agent tightening, not a
contract-verified fact** — a Solana holding is not verifiable from Arbitrum.
PS-F12-AC3 is reworded accordingly (HANDOFF §19).

## RetenixClaim (doc 14 — the estate transfer-out delegate; one per EVM chain)

| Network | Chain ID | Address | Verified | Deployed | Constructor (keeper / policy) | Notes |
|---|---|---|---|---|---|---|
| Arbitrum Sepolia | 421614 | `0xBc5D4524518E1af5cbFcFbC7fF0534fa4E59F94b` | ✓ [source](https://sepolia.arbiscan.io/address/0xbc5d4524518e1af5cbfcfbc7ff0534fa4e59f94b#code) | 2026-07-17, [tx](https://sepolia.arbiscan.io/tx/0x37b30be65d6e89fca1b069783a76a02298799a753fa774f5f110de9f6b401b71) (960,067 gas) | keeper = deployer `0x5629…ecD5` / policy = Sepolia RetenixPolicy `0x4549…c261` | rehearsal-parity deploy (gate enabled) |
| Arbitrum One | 42161 | `0x92427d60cda5f63740d95Ad972dFA5A115AdD8d0` | ✓ [source](https://arbiscan.io/address/0x92427d60cda5f63740d95ad972dfa5a115add8d0#code) | 2026-07-17, [tx](https://arbiscan.io/tx/0x531f8de6e53741a6d5d22749c119fe2c932a2d6f58253488f440969b274c13fc) (918,978 gas @ 0.0203 gwei = 0.0000186 ETH ≈ $0.07) | keeper = deployer `0x5629…ecD5` (DEV — immutable; KMS keeper ⇒ redeploy) / policy = `0x606c…6024` | recorded in `CLAIM_DELEGATE_ADDRESS_ARBITRUM` + `contracts.ts` |
| Ethereum | 1 | _pending owner deploy_ | — | — | keeper = KMS-or-dev / policy = `0` | deployer unfunded (bal ≈ $0.09) — run: `POLICY_ADDRESS=0 forge script script/DeployClaim.s.sol --rpc-url <eth> --broadcast --verify --etherscan-api-key $ETHERSCAN_API_KEY` |
| Base | 8453 | _pending owner deploy_ | — | — | keeper = KMS-or-dev / policy = `0` | deployer unfunded — same command with a Base RPC |
| BSC | 56 | _pending owner deploy_ | — | — | keeper = KMS-or-dev / policy = `0` | deployer unfunded (0 BNB) — same command with a BSC RPC |
| X Layer | 196 | _pending owner deploy_ | — | — | keeper = KMS-or-dev / policy = `0` | deployer unfunded (0 OKB) — ⚠ verify X Layer supports type-4 (7702) txs before relying on estate coverage there (doc 14 HANDOFF flag) |

## Chainlink Automation upkeep (custom-logic)

| Network | Upkeep ID | Forwarder | `setAutomationForwarder` tx | Status |
|---|---|---|---|---|
| Arbitrum One | _unregistered_ | _unset_ | — | runbook: `contracts/script/RegisterUpkeep.md`; registration owned by module 14's estate runbook |

## Rehearsal transcripts

### Sepolia dress rehearsal (demo beat 5 backend) — 2026-07-13, plan #0

| Beat | Outcome | Tx |
|---|---|---|
| createPlan $50/exec, $50/period, [spyx,tslax,sol] (owner-signed, relayed) | success | [0xcec73a…45c4](https://sepolia.arbiscan.io/tx/0xcec73affbe15cba7f1d5ec2a6871e7b74ec0d3ef7f8a2e4bf96ccfadf9dd45c4) |
| recordExecution $15 spyx | success | [0xde45d9…3817](https://sepolia.arbiscan.io/tx/0xde45d9aba14899fe22ea759d7b9cf8c26b382debfc53bb1e736a29f89c053817) |
| recordExecution $500 memecoin | **reverted OverExecCap** (0xc5ed6221) | [0x732768…1f7d](https://sepolia.arbiscan.io/tx/0x7327683097a84fac0efc311b3bd90fe89b64344f0690385a5969babbe1f71f7d) |
| recordExecution $30 memecoin | **reverted AssetNotAllowed** (0x48472343) | [0xbfeb17…6076](https://sepolia.arbiscan.io/tx/0xbfeb1711feac37d2cc2944f69cbed91aed29365c3d417c09f102507d2f816076) |
| recordExecution $45 spyx | **reverted OverPeriodCap** (0x4a706fdc) | [0xf50879…0921](https://sepolia.arbiscan.io/tx/0xf50879cf6df58beb8b6fc984bfb2582da0ad8ec7bf5a7c6558fe7bd56d40d921) |
| revokePlanFor #0 (owner-signed, relayed) | success — one tx zeroed authority | [0xbf6c0a…c255](https://sepolia.arbiscan.io/tx/0xbf6c0addf0b07680234169519d8af58b4577475a80e8dd93877745fe4347c255) |
| recordExecution $1 spyx after revoke | **reverted NotActive** (0x80cb55e2) | [0x3cc850…3357](https://sepolia.arbiscan.io/tx/0x3cc85034054eebc9a3b4974990f409f73dc7fd46636252f72f670fd12cb33357) |

PS-F5-AC1: blocked beats failed **at the contract** (status-0 onchain, named
custom errors). PS-F5-AC2: one revoke transaction zeroed the agent's authority.
Note: $500 memecoin reverts OverExecCap (check order), $30 proves the allowlist
— see HANDOFF 07.

## Rehearsal — gate G4 live on Arbitrum Sepolia (2026-07-17)

`G4_RPC_URL=<sepolia> G4_KEEPER_PRIVATE_KEY=<deployer> G4_CLAIM_DELEGATE=0xBc5D4524518E1af5cbFcFbC7fF0534fa4E59F94b pnpm --filter worker rehearse:g4` — **PASS 15/15 (LIVE)**:
estate enrolled (owner-signed, relayed) → DeadlineFired → 60s window → Claimable →
markClaimed (commit point) → Type-4 apply+registerHeir through the POLICY-GATED delegate
([tx 0x952f60…b42c](https://sepolia.arbiscan.io/tx/0x952f6034d76a9027b29ea05d90a58d18c67bf9820cd4ebba5b045054ef7bb42c)) →
getCode/heirOf verified → claim swept native to the heir → self-invalidation (stale Type-4
status 1, tuple silently skipped, no code, no event) → refreshed tuple applied.
Anvil (Prague) run: PASS 16/16 (adds the reverted-inner-call resume family).
Mainnet repeat = the same command with Arbitrum One values (G7 tiny balances).

---

# Operations (module 17)

Everything below is doc 17's half: where each environment variable lives, what a
leak of each store actually costs, how to rotate a key, and the provisioning
steps that need a human at a dashboard.

## Topology

| Component | Platform | Environments | Notes |
|---|---|---|---|
| `apps/web` | Vercel | preview per PR · staging · prod | the preview URL is the judge-clickable artifact (PS-8.1) |
| `apps/worker` | Railway | staging · prod | long-running Node; `node-cron` + pg-boss; **must be always-on** (G9) |
| Postgres | Railway | staging · prod | `DATABASE_URL` per environment |
| Contracts | Arbitrum Sepolia → One | — | addresses above; `POLICY_CONTRACT_ADDRESS` is the runtime source of truth |

Config-as-code: [`railway.json`](../railway.json) and
[`apps/web/vercel.json`](../apps/web/vercel.json). Neither holds a secret.

**`DEMO_MODE=1` on staging only.** Prod must never carry it: it is what makes
`POST /internal/demo/rogue` exist at all, and it shortens the estate timers to
120s/60s. The endpoint 404s before authentication when the flag is off, so a
judge-accessible prod cannot be probed for it.

**`NODE_ENV` is the single highest-leverage variable, and Railway does not set
it for you.** Three production fences read it: degraded boot (`index.ts`), the
dev raw agent key (`kms.ts`), and the dev escrow secret (`estate-support.ts`).
A prod service that boots without `NODE_ENV=production` will happily run
degraded on a dev key and never say so. Set staging to `staging`, **not**
`production`, so `ESCROW_DEV_SECRET` and degraded boot stay legal there.

## Where each variable lives

Names are doc 00's canonical set; never invent alternatives. Nothing here is
ever committed — `.env.example` files carry placeholders only.

| Variable | Vercel | Railway | GitHub Actions | Notes |
|---|:--:|:--:|:--:|---|
| `DATABASE_URL` | ✓ | ✓ | ✓ (CI service) | same Postgres for web + worker |
| `NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY` | ✓ | — | — | inlined into the browser bundle at build |
| `MAGIC_SECRET_KEY` | ✓ | — | — | server-side DID verification only |
| `NEXT_PUBLIC_PARTICLE_*` (3) | ✓ | — | — | UA SDK init, browser |
| `PARTICLE_PROJECT_ID` / `_CLIENT_KEY` / `_APP_UUID` | — | ✓ | ✓ (smoke) | UA SDK init, server |
| `ANTHROPIC_API_KEY` | ✓ | — | — | intent parsing |
| `SESSION_SECRET` | ✓ | — | — | HS256 cookie signing |
| `APP_BASE_URL` | ✓ | ✓ | — | claim links; must match the real origin |
| `INTERNAL_API_TOKEN` | ✓ | ✓ | — | **must be identical on both** |
| `AWS_REGION`, `KMS_AGENT_KEY_ID`, `KMS_ESCROW_KEY_ID` | ✓ (escrow only) | ✓ | — | prod signing lives here, not in env |
| `RPC_URL_*` (6) | ✓ | ✓ | ✓ (`RPC_URL_ARBITRUM`) | never `NEXT_PUBLIC_` — the browser must not read them |
| `POLICY_CONTRACT_ADDRESS`, `CLAIM_DELEGATE_ADDRESS_*` | ✓ (claim) | ✓ | — | public addresses |
| `ALCHEMY_WEBHOOK_SIGNING_KEY` | — | ✓ | — | verifies Address Activity webhooks |
| `SLACK_STATUS_WEBHOOK_URL` | — | ✓ | ✓ (smoke) | TS-16.4 — a requirement, not a nice-to-have |
| `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_DSN` | ✓ | ✓ | — | web / worker |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | ✓ (build) | — | — | source-map upload only; Sentry CLI's own names |
| `INTERNAL_ROUTES_PRIVATE_ONLY` | — | ✓ | — | `1` in prod, `0` in staging |
| `DEMO_MODE` | staging only | staging only | — | **never on prod** |
| `SMOKE_WALLET_PRIVATE_KEY` | — | — | ✓ | the only key that ever spends unattended |
| `CI_DAILY_BUDGET_USD` (5) · `SMOKE_CONVERT_USD` (1) | — | — | ✓ (vars) | budget caps — never raised |

Platform-injected, never set by hand: `VERCEL_GIT_COMMIT_SHA`,
`RAILWAY_GIT_COMMIT_SHA`, `GITHUB_SHA` (the Sentry release), and `PORT`.

## Secrets policy

**Prod agent, keeper and escrow keys live in AWS KMS only** — `KMS_AGENT_KEY_ID`
and `KMS_ESCROW_KEY_ID`. Particle's own documentation warns that env-var keys
are development-only (TS-2.11), and CloudTrail is the per-execution audit log
(TS-14.1): every KMS signature is a logged line naming the estate it was for.

Three keys are **dev-only** and labelled as such at their definition:

| Key | Where | If it leaks |
|---|---|---|
| `AGENT_EOA_PRIVATE_KEY` | worker (dev) | bounded by `RetenixPolicy`'s onchain caps and allowlists — an attacker gets the agent's *permission*, which is capped per execution and per period, restricted to an asset allowlist, and revocable in one transaction |
| `SMOKE_WALLET_PRIVATE_KEY` | CI | **≤ $50** — that cap is the funding itself, and it is the maximum possible loss from any CI malfunction |
| `DEPLOYER_PRIVATE_KEY` | contracts (Sepolia) | whatever the wallet holds; keep it near-empty between deploys |

Never: a prod signing key in env, in the repo, or in a CI log.

## Blast radii

| Store | What an attacker gets | What they do **not** get |
|---|---|---|
| **Vercel env** | Particle client credentials, the Anthropic key, `SESSION_SECRET`, the relayer key | no funds beyond relayer gas; the agent key is in KMS |
| **Railway env** | `INTERNAL_API_TOKEN`, RPC URLs, demo config, KMS *key ids* | **not the KMS keys** — a key id is a pointer; signing needs IAM credentials, and every use is a CloudTrail line |
| **GitHub secrets** | the smoke wallet | ≤ $50, and the daily budget guard caps a single day at $5 |
| **The repo itself** | nothing | verified: gitleaks over all 172 commits finds zero credentials |

Rotate on any suspicion. `SESSION_SECRET` rotation logs everyone out, which is
the correct behaviour and costs one OTP each.

## Rotation drill

**The good news, by design (doc 07):** `relayer` and `keeper` are *settable* on
`RetenixPolicy`. Rotating a leaked server key is a config change plus a contract
call — **not a redeploy**:

```bash
# 1. mint the replacement, fund it for gas
# 2. point the contract at it
cast send $POLICY_CONTRACT_ADDRESS "setRelayer(address)" $NEW_RELAYER \
  --rpc-url $ARBITRUM_ONE_RPC_URL --private-key $OWNER_KEY
# 3. update RELAYER_PRIVATE_KEY in Vercel, redeploy
# 4. drain the old address
```

**Two things this does NOT cover, and both are load-bearing:**

1. **`agent` is IMMUTABLE on `RetenixPolicy`.** Moving the agent to a KMS key is
   a **redeploy** (~$0.30 on Arbitrum), then updating `POLICY_CONTRACT_ADDRESS`,
   `packages/shared/src/contracts.ts`, and this file. The worker asserts the
   match at boot and refuses to start on a mismatch, with the fix printed —
   every `recordExecution` would otherwise revert `NotAgent`.
2. **`RetenixClaim`'s keeper is IMMUTABLE, and rotating it strands nobody's
   estate only if you keep the old one alive.** Escrowed 7702 tuples were signed
   against a specific delegate address and are bound to the EOA's nonce at
   signing time. An inactive owner's tuple points at the **old** delegate
   forever — so after a keeper rotation, the old delegate contract and the old
   keeper key must both stay operational until every affected estate has either
   re-enrolled or been claimed. This is an ops invariant, not a nice-to-have.

## Monitoring

- **Sentry**, both apps, release = git SHA, with PII scrubbing shared from
  `@retenix/shared/observability`: no emails, no signatures, no tuple material,
  no claim tokens. Transaction hashes deliberately survive — they are what an
  incident is investigated with.
- **Slack** (`SLACK_STATUS_WEBHOOK_URL`) on five triggers: terminal execution
  failure post-retries, blocked receipts (informational), the daily smoke
  result, keeper state changes (deadline fired, claim executed), and a low
  Chainlink LINK balance.
- **`GET /internal/health`** (bearer `INTERNAL_API_TOKEN`) — queue depth, last
  tick per cron, RPC reachability; 200 healthy / 503 degraded.
  **`GET /healthz`** stays unauthenticated and dependency-free because Railway's
  probe cannot send a header. Point the platform healthcheck at `/healthz` and
  an uptime monitor at `/internal/health`.

**LINK balance is the one to watch.** An upkeep that runs out of LINK does not
error or retry — the inactivity deadline simply never fires, and nothing else in
the system notices. Warn below 2 LINK (`LINK_BALANCE_WARN`), against the ≥5 LINK
starting deposit `contracts/script/RegisterUpkeep.md` specifies.

## Provisioning runbook (owner)

Each step needs a human at a dashboard or a funded wallet.

1. **Vercel** — new project, root directory `apps/web`, and **"Include files
   outside of the Root Directory in the Build Step" ON**. This is not optional:
   `transpilePackages` compiles from `packages/*/src`, and the Particle patch
   lives at the repo root, so the install fails without it. Node 22. Enter the
   web variables for Production *and* Preview.
2. **Railway** — new project, root directory `/` (not `apps/worker` — that would
   hide `pnpm-workspace.yaml`, the lockfile, and `patches/`). Add the Postgres
   plugin. Set `RAILPACK_NODE_VERSION=22.16.0`: `pg-boss@12` declares
   `node >=22.12` while the repo's `engines` says `>=20`. Pick an **always-on**
   tier — a sleep-on-idle plan silently stops the scheduler (G9).

   **Schema.** `railway.json` sets `preDeployCommand: pnpm db:push`, which runs
   against the new deployment before it serves traffic. Without it a fresh
   Postgres has no tables at all and the worker fails on its first query — CI
   applies the schema to its own throwaway database, and nothing was applying it
   here. Two properties worth knowing: `drizzle-kit` is a devDependency, which
   is correct because a pre-deploy step is deploy-time tooling in the same
   category as `tsc` (unlike `tsx`, which is runtime and therefore a real
   dependency); and `push` is deliberately run **without `--force`**, so a
   change that would truncate data fails the deploy loudly instead of applying
   itself to production.
3. **Sentry** — org + two projects (web, worker). Put the DSNs in Vercel and
   Railway, and `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` in Vercel
   for source-map upload.
4. **Slack** — an incoming webhook; the URL goes to Railway and to GitHub
   secrets. Until it exists, the worker logs its messages instead of posting.
5. **AWS** — KMS keys (`ECC_SECG_P256K1`, sign-only) for the agent and the
   escrow. Verify with `pnpm --filter worker smoke:kms`. Note the agent-key
   redeploy above before switching.
6. **Smoke wallet** — fund a fresh EOA to **≤ $50** and add
   `SMOKE_WALLET_PRIVATE_KEY` to GitHub secrets, with `PARTICLE_*`,
   `RPC_URL_ARBITRUM`, and `SLACK_STATUS_WEBHOOK_URL`. The daily convert stays
   skipped, with a warning, until all of these exist.
7. **Magic dashboard** — allowlist `localhost:3000`, the Vercel preview domain
   pattern, and the exact demo origin, or signing fails on stage. Enable 2FA
   (TS-14.5).
8. **Chainlink** — register the custom-logic upkeep on Arbitrum One
   (`contracts/script/RegisterUpkeep.md`), fund it, call
   `setAutomationForwarder`, then set `LINK_TOKEN_ADDRESS` and
   `CHAINLINK_UPKEEP_ADMIN` so the balance alert starts working.
9. **Alchemy** — Address Activity webhooks on the five EVM chains pointing at
   `POST <worker>/webhooks/alchemy`; put the signing key in Railway.
10. **Email** — Resend (PROPOSED, swappable): create the key and verify a
    sending domain. Absent, heir claim links are logged loudly rather than
    emailed, and the demo still proceeds.

### Drills to run once provisioned

- **Forced failure.** `pnpm --filter worker rehearse:failure` against staging →
  a Sentry event and a Slack message with the execution row and tx, inside 60s.
- **Budget guard.** Set the `CI_DAILY_BUDGET_USD` repo *variable* to `1` and run
  `mainnet-smoke` twice: the second run must refuse. This rehearses the
  same-day refusal **without spending $5**. Set it back to `5`.
- **Mis-funding tripwire.** Fund the smoke wallet past the native ceiling → the
  preflight refuses before spending anything.
- **Internal routes.** With `INTERNAL_ROUTES_PRIVATE_ONLY=1`, curl
  `POST /internal/execute-now` at the public URL → 404 even with a valid token.
