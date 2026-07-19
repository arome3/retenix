# Universal Accounts + EIP-7702 — Retenix

**Retenix is a self-custodial brokerage that runs itself.** An AI broker invests your entire
cross-chain balance, a guardian enforces your limits onchain, and a continuity agent knows how to end
things — kill switch, stop-loss, or inheritance.

Universal Accounts are not a convenience layer here. They are the reason the product is possible at
all: **the assets live on Solana** (~93–95% of tokenized-equity volume) **while consumers' money sits
on EVM chains.** Every incumbent makes the user cross that gap themselves. We do not, because the UA
SDK routes and settles across all six networks — Ethereum, Base, Arbitrum, BSC, X Layer, Solana —
from one balance the user never has to disaggregate.

---

## Four load-bearing usages of 7702

Not four demos of the same trick. Four different problems that 7702 is the only clean answer to.

### 1. The user's own EOA, upgraded in place

Onboarding creates no new address. The account a user already has *becomes* the smart account, via a
7702 authorization signed headlessly through Magic (`sign7702Authorization`, then
`Signature.from({v,r,s}).serialized`). Nothing to migrate, nothing to fund, no "send your assets to
your new wallet" step — the single most common place consumer crypto loses people.

This matters most at the *end*. When someone exports their key from Retenix, they get the key to the
address they have always had. Self-custody is not a claim we make in the marketing; it is a property
of having never moved them off their own account.

**Proven on mainnet.** Magic's own documentation signs 7702 on Sepolia. We ran it on **Arbitrum One
(42161)** as a blocking week-1 gate and verified the result independently with ethers:
`recoverAddress(hashAuthorization({address, chainId: 42161, nonce}), sig)` returns the session EOA.
The tuple we hand the UA SDK is cryptographically valid and signed by the user's own key.

### 2. The agent EOA, 7702-upgraded on the backend

The execution agent is itself a Universal Account in 7702 mode, signing through the same code path
with an AWS KMS-backed signer instead of a browser. One integration layer (`packages/ua`), two
signers — `magicSigner` in the browser, `kmsSigner` on the server, both satisfying the same
`UaSigner` interface. The worker never imports Magic; the browser never sees a server key.

The agent's authority is bounded **onchain**, not by our good intentions: `RetenixPolicy` holds a
per-execution cap, a per-period cap, and an asset allowlist, and every execution must be recorded
onchain *before* the send. A compromised agent server cannot exceed what the contract permits, and
one transaction revokes it entirely.

### 3. Escrowed re-delegation — a dead-man switch that needs no second delegation

This is the hard one, and it is where 7702's central constraint becomes the design.

An EOA can hold **exactly one** delegation per chain. In normal operation that slot is occupied by
Particle's UA contract — which is what makes the account work. So how does an heir ever gain access
to an account whose one delegation slot is permanently in use?

The answer is a 7702 authorization signed **at enrollment**, delegating to our audited `RetenixClaim`
contract, then encrypted (KMS envelope) and escrowed server-side. It is never applied while the owner
is alive. It becomes applicable only after the onchain estate reaches `Claimable`.

The elegance is that **the tuple invalidates itself**. A 7702 authorization is bound to the EOA's
nonce at signing time, and *any* owner activity increments that nonce. An owner who is alive and
transacting is continuously and automatically destroying the escrowed capability without doing
anything, thinking about anything, or trusting us to delete it. Liveness is not attested — it is
structural.

**Proven end to end on a live chain**, not just anvil: enroll → deadline fired → challenge window →
`Claimable` → `markClaimed` → Type-4 transaction applying the tuple + `registerHeir` → assets swept
to the heir → then a *stale* tuple correctly failing to apply. 15/15 on Arbitrum Sepolia; 16/16 on
anvil with the Prague hardfork. The first live attempt **failed correctly** — the delegate refused
`registerHeir` for an estate that had never been `Claimable`. The gate working is better evidence
than the happy path.

### 4. Batched enrollment — one signature for a whole policy

Authoring a plan means an onchain policy, an asset allowlist, and caps. Through the UA's batching, a
user confirms once and signs once; the many headless signatures the SDK needs underneath are exactly
that — underneath. The pattern generalises across the product as **"one confirmation, N headless
signatures"**: the dust sweep consolidates balances from five networks on a single tap.

---

## Every movement type, exercised cross-chain

`buy`, `sell`, `convert`, and `transfer` are all in the shipped product, not a sample app:

| Flow | UA method | Where it lives |
|---|---|---|
| Scheduled basket buys | `createBuyTransaction` | the worker's execution pipeline, per basket leg |
| Kill switch, take-profit | `createSellTransaction` | "Liquidate & Lock" unwinds every position to USDC |
| Dust sweep | `createConvertTransaction` | non-primary balances on six networks → buying power, one signature |
| Send / withdraw | `createTransferTransaction` | to an email, an ENS name, or an address |

Fees come from the SDK's own preview and are rendered in every receipt, split gas / service / LP.
Nothing is hardcoded, and a mixed basket that touches Ethereum shows a visibly higher fee split than
one that does not — because it should.

---

## The Dexari pain points, answered

Particle's own case study frames the problem in two lines. We took them literally.

> *"No unified balance — funds fragmented across chains couldn't be combined into a single tradable
> balance."*

Retenix's **buying power *is* the unified balance.** It is the first number a user sees after login,
and it is one number. Tap it and the breakdown shows provenance — "sourced from 4 networks" — because
transparency belongs in receipts. It never appears as a decision. Nobody picks a network to invest.

> *"Gas tokens and network-specific steps block onboarding."*

Email → invested, with **zero network-aware steps and no gas token acquired at any point.** No
bridging screen, no "you need ETH on Base first," no chain switcher. The words *gas*, *bridge*, and
*chain* are banned from decision surfaces and a CI job fails the build if they appear — the
vocabulary discipline is enforced, not aspirational.

Dexari showed what one exchange gains from a unified balance. Retenix gives that to a consumer with
$200 scattered across four networks.

---

## The honest trust gradient

Judges reward the found constraint, so here is ours, stated plainly.

**What the contract guarantees, with or without us.** Caps and allowlists are onchain. An
out-of-policy attempt reverts at the contract — provably, in the explorer. `revokeAll` zeroes agent
authority in one transaction. The inactivity deadline fires from Chainlink Automation, not our cron,
so it works if Retenix is dark.

**What requires trusting the keeper, and how far.** The escrowed tuple is ciphertext at rest, useless
before `Claimable` (the keeper checks the contract, and on Arbitrum the delegate re-checks
independently), and self-invalidating on any owner activity. A compromised keeper still cannot claim
an estate whose owner is alive — the contract will not let it. What a compromised keeper *could* do
is fail to act for an estate that has legitimately become claimable. Inheritance is therefore
**censorship-resistant in the direction that matters (nobody can take your assets early) and
liveness-dependent in the other (we must show up to hand them over).** `fireDeadline` is
permissionless precisely so the first half does not depend on us.

**Where a claim of ours is weaker than it sounds.** Our copy says agents can never block your kill
switch. Against *our* contracts that is true. But every tokenized equity we list is Token-2022 with a
live `freezeAuthority` and a `permanentDelegate` — the issuer can freeze or claw back a position
regardless of what our contract says. That is a property of tokenized equities, not of Retenix, and
we would rather say so than let the sentence stand unqualified.

**One thing that did not ship.** Guardian Hedge (protective shorts as the middle rung of the safety
ladder) is built and feature-flagged **off**. Its venue, Ostium, was exploited on 2026-07-15 — ~$18M
out of the OLP vault via a compromised oracle signer — and trading is still halted. We built the
contract, fuzzed it across 128,000 interleavings, and shipped it disabled rather than point a
consumer product at a venue that is offline. The gate failed; we respected the gate.

---

## Rubric mapping

**User experience — 40.** Email to first automated investment in under three minutes, with zero
network-aware steps. One balance, plain-English policies, a fee split in every receipt. The banned
vocabulary is CI-enforced; every token pair is checked against WCAG 2.2 AA in CI; the whole product
is one 480px column that works on a phone. Measured: onboarding 18.1s against a 60s budget.

**Universal Accounts + 7702 creativity — 30.** Four structurally different usages (above), of which
the escrowed re-delegation dead-man switch is, as far as we can tell, novel: a use of 7702's
nonce-binding as a *liveness oracle* rather than as a replay guard. The one-delegation-per-chain
constraint stopped being a limitation and became the mechanism.

**Adoption potential — 20.** The consumer wedge is real and dated: tokenized stocks were 2026's
strongest consumer-crypto narrative, and the money is on the wrong chain from the assets. Retenix
needs no new user behaviour — no new address, no bridging, no gas. Persona P3 alone ("self-custodied
since 2017, wants his family to inherit it") is addressing the ~$121B sitting in decade-dormant BTC.

**Technical execution — 10.** 1,160 unit tests, 124 Foundry tests, contracts deployed and verified on
Arbitrum One, a Playwright walk over all seven demo beats, a daily $1 mainnet convert in CI as the
SDK-pin tripwire, and a secrets scan over all 172 commits. The SDK is pinned to exactly 2.0.3 and
touched by exactly one package.

---

*Retenix — Arnen Labs. Six networks: Ethereum, Base, Arbitrum, BSC, X Layer, Solana.*
