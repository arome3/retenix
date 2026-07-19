# Chainlink Automation — custom-logic upkeep registration (RetenixPolicy)

RetenixPolicy implements a **custom-logic (conditional) upkeep** (CONFLICTS #12):
`checkUpkeep(bytes)` scans `enrolledOwners` for estates past
`lastCheckIn + inactivitySecs`; `performUpkeep(performData)` is gated to the
Chainlink **forwarder** and calls `fireDeadline(owner)`, which revalidates the
condition onchain. `fireDeadline` itself stays permissionless, so the deadline
can fire even without Chainlink — Chainlink buys guaranteed liveness, not
authority. Do **not** register a time-based upkeep: time-based upkeeps call a
target function on a schedule and never consult `checkUpkeep`.

The estate-side runbook (when to register, demo timing, LINK budget ownership)
belongs to module 14; this file documents the mechanical steps because the
contract surface (`checkUpkeep`/`performUpkeep`/`setAutomationForwarder`) is
owned here.

## Steps (UI — automation.chain.link)

1. Open https://automation.chain.link, connect a funded wallet, and select the
   network: **Arbitrum One** (prod) or **Arbitrum Sepolia** (rehearsal;
   testnet LINK + ETH from https://faucets.chain.link).
2. **Register new Upkeep** → trigger = **Custom logic**.
3. Target contract address = the deployed `RetenixPolicy`
   (`POLICY_CONTRACT_ADDRESS`).
4. Upkeep name: `retenix-policy-estate-deadline`. Check data: `0x` (unused).
5. Gas limit: **500,000** (perform decodes one address and runs
   `fireDeadline` — ~60k — but `checkUpkeep`'s scan grows with
   `enrolledOwners`; headroom is cheap).
6. Starting LINK balance: ≥ **2 LINK** testnet / ≥ **5 LINK** on One.
   Premium on Arbitrum is ~50% of gas cost paid in LINK — **verify the
   current tier on the registration screen** (tech spec §2 note).
7. Confirm the registration transaction and wait for the upkeep page to show
   **Active**.

## Post-registration (required — performUpkeep is forwarder-gated)

1. On the upkeep's details page, copy the **Forwarder address**.
2. As the contract admin (the deployer key):

   ```bash
   cast send "$POLICY_CONTRACT_ADDRESS" "setAutomationForwarder(address)" <FORWARDER> \
     --rpc-url "$ARBITRUM_ONE_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY"
   ```

3. Verify: `cast call "$POLICY_CONTRACT_ADDRESS" "automationForwarder()(address)" --rpc-url …`
   returns the forwarder.
4. Record the upkeep ID + forwarder address in `docs/deployments.md`.

## CLI alternative

Registration can also be done through the `KeeperRegistrar` contract
(`registerUpkeep` with `triggerType = 0` for conditional); the UI path above is
simpler and is what doc 07 assumes ("Chainlink registration is UI/CLI").

## Verifying liveness

- Enroll a demo estate (module 14 flow, or `enrollEstate` directly), let
  `inactivitySecs` (demo: 120s) elapse without a check-in.
- The upkeep page shows a performed upkeep; `estateStatus(owner)` moves to
  `Countdown`, then `Claimable` after `challengeWindowSecs` (demo: 60s).
- The Retenix-is-dark story: pause the worker entirely — the deadline still
  fires, because only Chainlink (or anyone, via permissionless
  `fireDeadline`) is needed.

## Module 14 estate runbook (owner-run, W1/demo week)

1. **OQ6 (TS-17.6)**: at the registration screen, note the ACTUAL Arbitrum
   premium % (parsed ~50%) and size the LINK deposit from it. Record the
   number in HANDOFF/doc 16's runbook; pre-check the upkeep balance in the
   demo-day checklist.
2. Until the upkeep is registered, the worker keeper fires due deadlines
   itself (`keeper.ts` — fireDeadline is permissionless; a liveness belt,
   never the guarantee). After registration, prove the chaos split (doc 14
   DoD): **stop the worker**, let a demo estate lapse, and confirm the
   upkeep alone moves it to Countdown/Claimable; restart the worker and
   watch it complete the claim later.
3. The claim delegates are separate deployments (`DeployClaim.s.sol`, one per
   estate chain — addresses in `docs/deployments.md`; Ethereum/Base/BSC/
   X Layer are pending the funded deployer). RetenixClaim's `keeper` is
   IMMUTABLE: rotating the keeper key means redeploying delegates on every
   chain, and inactive owners' escrowed tuples keep pointing at the OLD
   delegate — the old delegate + old keeper key must stay operational for
   them (ops invariant).
4. Verify X Layer supports type-4 (EIP-7702) transactions before counting it
   in live estate coverage — flagged in HANDOFF (doc 14).
