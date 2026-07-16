# Worker rehearsal & smoke scripts (doc 08)

Owner-run, **env-gated mainnet** tools (UA has no testnet — G7: $50 smoke
wallet, $5/day budget). With placeholder credentials every script prints its
owner-action and exits 0, so CI and fresh clones stay green.

Prereqs for live runs: real `PARTICLE_*`, deployed `POLICY_CONTRACT_ADDRESS`,
an agent signer (`AGENT_EOA_PRIVATE_KEY` dev key **matching the contract's
immutable `agent`**, or a real KMS key — mismatch prints the ~$0.30 redeploy
runbook), local Postgres with the schema pushed, and a funded agent UA plus a
little Arbitrum ETH on the agent EOA for `recordExecution`/`refundExecution`
gas.

| Script | Proves | Run |
|---|---|---|
| `smoke:kms` | KMS DER→RSV signer executes a $1 mainnet convert (G5 digests, 7702 auth, low-s) | `pnpm --filter worker smoke:kms` |
| `rehearse:staging` | scheduled leg end-to-end: `recordExecution` included → UA FINISHED → receipt with amount/ticker/fees/sources/universalx link (PS-F4-AC2) | `pnpm --filter worker rehearse:staging` ($2/day SOL) · `-- --weekly-basket` + `RETENIX_CONFIRM_SPEND=25` for the $25/week 60-30-10 DoD shape (module 16 window) |
| `rehearse:rogue` | out-of-policy attempt blocked **onchain**, receipt within seconds (beat 5) | worker running with `DEMO_MODE=1`; `STAGING_PLAN_ID=… pnpm --filter worker rehearse:rogue` |
| `rehearse:failure` | forced UA failure → `refundExecution` before every retry → eventual failed-refunded receipt | `DEMO_MODE=1 FAULT_INJECT_UA=corrupt-root-sig pnpm --filter worker rehearse:failure` |
| `verify:nodup` | zero duplicate sends/receipts per leg (idempotency audit) | `STAGING_PLAN_ID=… pnpm --filter worker verify:nodup` |

## Kill-mid-poll / resume runbook (zero-duplicate proof)

1. `pnpm --filter worker rehearse:staging` → note the printed `plans` row id.
2. Start the worker: `pnpm --filter worker dev`. Wait for the next scheduled
   period (or `curl -X POST -H "authorization: Bearer $INTERNAL_API_TOKEN" -d '{"planId":"…"}' localhost:8080/internal/execute-now` for a fresh period).
3. Watch the logs; the moment `step5:submitted` / polling appears, **`kill -9`
   the worker process** (SIGKILL — no graceful path).
4. Restart the worker. pg-boss retries the job within ~1 min (60 s
   heartbeats); the executor resumes at the persisted `submitted` state and
   only POLLS — watch for `resume`/`step6` lines, never a second send.
5. `STAGING_PLAN_ID=… pnpm --filter worker verify:nodup` → every leg shows
   `ua_tx_ids=1, finished=1, receipts=1`.

Also rehearsable: kill between `step4:recorded` and `step5:submitted` — the
restart probes the persisted create-time `transactionId` first and only
re-quotes/sends after three definitive not-found probes (never on errors).
