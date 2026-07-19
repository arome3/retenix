# Arbitrum — Retenix

**Retenix is a self-custodial brokerage that runs itself.** Arbitrum One is where its authority
lives: the contract that decides what the agent may and may not do, the estate state machine that
decides when an heir may claim, and the Chainlink upkeep that fires the inactivity deadline whether
or not our servers are running.

---

## Deployed and verified

| Contract | Address | Verified | Cost |
|---|---|---|---|
| `RetenixPolicy` | [`0x606cDadeeb7FF1e3d86C92e34b2e24dC9E9C6024`](https://arbiscan.io/address/0x606cdadeeb7ff1e3d86c92e34b2e24dc9e9c6024#code) | ✓ source | 4,048,568 gas @ 0.0201 gwei = **≈ $0.28** |
| `RetenixClaim` | [`0x92427d60cda5f63740d95Ad972dFA5A115AdD8d0`](https://arbiscan.io/address/0x92427d60cda5f63740d95ad972dfa5a115add8d0#code) | ✓ source | 918,978 gas = **≈ $0.07** |
| `RetenixHedge` | [`0x26631E4088658c691AEf560313eE7564a1cfA2e1`](https://arbiscan.io/address/0x26631e4088658c691aef560313ee7564a1cfa2e1#code) | ✓ source | 2,239,005 gas = **≈ $0.16** |

Arbitrum Sepolia counterparts are deployed and verified too; the full record, with transaction hashes
and constructor arguments, is in [`docs/deployments.md`](deployments.md).

**Etherscan API V2** made this one key across every network:

```bash
forge script script/Deploy.s.sol --rpc-url $ARBITRUM_ONE_RPC_URL --broadcast --verify \
  --verifier-url "https://api.etherscan.io/v2/api?chainid=42161" \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

The `chainid` query parameter is the whole migration. One key, one workflow, Sepolia and One
identical apart from a number — which matters more than it sounds when the promotion from testnet to
mainnet happens the week of a demo.

---

## Why Arbitrum is the settlement home

**Three reasons, in the order they actually decided it.**

**1. The guardrails have to be cheap enough to use on every execution.** Retenix does not merely
*check* a policy before acting — it writes `recordExecution` onchain *before* the send, so the
contract, not our server, is the authority on whether a $15 buy was within a $50 weekly cap. That is
a transaction per execution per leg. At ~0.02 gwei that is affordable; on L1 the design would be
unaffordable and we would have quietly moved the check into our own database, which is exactly the
"trust us" posture the product exists to avoid. **The cost profile is what lets the guarantee be
real.**

**2. Chainlink Automation runs here.** The inactivity deadline is the one mechanism that must survive
Retenix disappearing entirely, so it cannot be our cron. Arbitrum One is a supported Automation
network, which means the trust-critical timer and the contract holding the estate state sit on the
same chain — no cross-chain message, no bridge, no additional failure mode between the timer and the
thing it fires.

**3. It is where the money already is.** Users arrive holding USDC on Arbitrum more than anywhere
else, and the agent needs a gas balance somewhere. Settling authority where the liquidity already
sits removes a hop we would otherwise have to explain.

Worth stating: **Arbitrum is the settlement home, not the whole product.** Value moves across six
networks through Universal Accounts, and the equities themselves are on Solana. Arbitrum is where the
*rules* live — the single place a judge, an auditor, or a suspicious user can go to check what an
agent is permitted to do.

---

## The guardrails, proven onchain

A dress rehearsal on Arbitrum Sepolia drove the exact sequence the demo shows. Every blocked attempt
is a **status-0 transaction with a named custom error** — visible in the explorer, not a log line we
wrote about ourselves.

| Attempt | Result | Transaction |
|---|---|---|
| `createPlan` $50/exec, $50/period, `[spyx, tslax, sol]` | success | [`0xcec73a…45c4`](https://sepolia.arbiscan.io/tx/0xcec73affbe15cba7f1d5ec2a6871e7b74ec0d3ef7f8a2e4bf96ccfadf9dd45c4) |
| `recordExecution` $15 SPYx — within policy | success | [`0xde45d9…3817`](https://sepolia.arbiscan.io/tx/0xde45d9aba14899fe22ea759d7b9cf8c26b382debfc53bb1e736a29f89c053817) |
| **$500 memecoin** — the demo's rogue instruction | **reverted `OverExecCap`** | [`0x732768…1f7d`](https://sepolia.arbiscan.io/tx/0x7327683097a84fac0efc311b3bd90fe89b64344f0690385a5969babbe1f71f7d) |
| **$30 memecoin** — under the cap, off the allowlist | **reverted `AssetNotAllowed`** | [`0xbfeb17…6076`](https://sepolia.arbiscan.io/tx/0xbfeb1711feac37d2cc2944f69cbed91aed29365c3d417c09f102507d2f816076) |
| **$45 SPYx** — allowed asset, exhausted period budget | **reverted `OverPeriodCap`** | [`0xf50879…0921`](https://sepolia.arbiscan.io/tx/0xf50879cf6df58beb8b6fc984bfb2582da0ad8ec7bf5a7c6558fe7bd56d40d921) |
| `revokePlanFor` — owner-signed, relayed | success | [`0xbf6c0a…c255`](https://sepolia.arbiscan.io/tx/0xbf6c0addf0b07680234169519d8af58b4577475a80e8dd93877745fe4347c255) |
| **$1 SPYx after revoke** | **reverted `NotActive`** | [`0x3cc850…3357`](https://sepolia.arbiscan.io/tx/0x3cc85034054eebc9a3b4974990f409f73dc7fd46636252f72f670fd12cb33357) |

Note the second and third rows together: **$500 fails on the cap, and $30 fails on the allowlist.**
Two independent controls, and the cheaper attempt is the one that proves the allowlist is real rather
than a side effect of the cap.

**One transaction zeroed the agent's authority**, and the very next execution attempt reverted. There
is no "revocation propagating" state, no queue to drain, no window in which a compromised agent still
has a little authority left.

In the product, a revert is not an error screen. It becomes a **blocked receipt** — amber shield,
same size and register as a successful one, with the reason in plain English ("Blocked: exceeds your
$50 weekly cap") and a link to the reverted transaction. It is rendered proudly, because a guardian
that visibly stops something is the feature.

## Estate lifecycle, live on Arbitrum

The full inheritance path was exercised against a live chain: enroll → `DeadlineFired` → 60s
challenge window → `Claimable` → `markClaimed` → a **Type-4 (EIP-7702) transaction** applying the
escrowed authorization and registering the heir
([`0x952f60…b42c`](https://sepolia.arbiscan.io/tx/0x952f6034d76a9027b29ea05d90a58d18c67bf9820cd4ebba5b045054ef7bb42c))
→ assets swept to the heir → a **stale** tuple correctly declining to apply.

15/15 live, 16/16 on anvil with the Prague hardfork. `markClaimed` is the single global commit point:
nothing irreversible happens on any chain before it.

---

## Honest constraints

**`agent` is immutable on `RetenixPolicy`, and today it is a development EOA.** Moving the agent to a
KMS-backed key is a redeploy (~$0.30), not a config change — and the worker refuses to boot on a
mismatch rather than discovering it one reverted `recordExecution` at a time. We chose immutability
deliberately: a settable agent is a settable *attacker*, and the redeploy cost on Arbitrum is small
enough that immutability is affordable. `relayer` and `keeper` **are** settable, so rotating those is
a contract call.

**The Chainlink upkeep is not yet registered.** Until `setAutomationForwarder` is called,
`performUpkeep` reverts `NotForwarder`. Estate liveness is still testable and demonstrable because
`fireDeadline` is **permissionless by design** — anyone can fire a genuinely-due deadline, which is
also what stops the feature depending on us being alive.

**`RetenixClaim` exists on Arbitrum One and Sepolia only.** The other four EVM chains are pending a
funded deployer. Estate coverage is honest about which networks it covers rather than implying all
six, and X Layer carries an additional caveat: it is a Polygon-CDK chain and we have not verified
type-4 transaction support there.

**`RetenixHedge` is deployed, verified, and switched off.** Its venue was exploited five days before
this was written. We shipped the contract and disabled the feature rather than point a consumer
product at a halted exchange.

---

## Cost, for the record

Every contract in this product cost **under $0.30 to deploy**, and the three together came to about
$0.51. A guardrail you can afford to enforce on every single execution is a different product from
one you can only afford to check occasionally — and that difference is the entire reason the caps are
onchain instead of in our database.

One practical note for anyone deploying here: forge estimates an EIP-1559 max fee at roughly 2× base,
and Arbitrum's base fee floors at 0.01 gwei. Twice, the *buffer* rather than the real cost exceeded
the deployer's balance. `--legacy --with-gas-price 25000000` sends at a genuine premium and succeeds.
Actual spend on the hedge deploy was 0.0000451 ETH against a 0.0001 ETH balance.

---

*Retenix — Arnen Labs. Six networks: Ethereum, Base, Arbitrum, BSC, X Layer, Solana.*
