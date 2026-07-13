#!/usr/bin/env bash
# Sepolia dress rehearsal (doc 07) — this script IS demo beat 5's backend:
#   createPlan($50/exec, $50/period, [spyx,tslax,sol])
#   → recordExecution($15, spyx)            ok
#   → recordExecution($500, memecoin-hash)  reverts OverExecCap  ($500 > $50/exec)
#   → recordExecution($30,  memecoin-hash)  reverts AssetNotAllowed (caps pass, list blocks)
#   → recordExecution($45,  spyx)           reverts OverPeriodCap ($15+$45 > $50)
#   → revokePlanFor (owner-signed, relayed) → any recordExecution reverts NotActive
#
# NOTE the check order is spec-verbatim exec-cap → period-cap → allowlist, so the
# doc's "$500 memecoin ⇒ AssetNotAllowed" beat actually reverts OverExecCap; the
# $30 beat is added to prove AssetNotAllowed onchain too (HANDOFF 07).
#
# Every failing beat is first simulated (cast call, asserting the exact custom
# error selector) and then SENT with an explicit gas limit so the reverted
# transaction lands onchain — provable in the explorer (PS-F5-AC1).
#
# usage: script/rehearsal.sh <policy-address> [rpc-url]
# env:   DEPLOYER_PRIVATE_KEY (doubles as the plan's agent on dev deploys)
set -euo pipefail

POLICY="${1:?usage: rehearsal.sh <policy-address> [rpc-url]}"
RPC="${2:-${ARBITRUM_SEPOLIA_RPC_URL:?set ARBITRUM_SEPOLIA_RPC_URL or pass rpc-url}}"
: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY}"

CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
case "$CHAIN_ID" in
  421614) EXPLORER="https://sepolia.arbiscan.io" ;;
  42161)  EXPLORER="https://arbiscan.io" ;;
  *)      EXPLORER="(unknown explorer, chain $CHAIN_ID)" ;;
esac

DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
AGENT=$(cast call "$POLICY" "agent()(address)" --rpc-url "$RPC")
if [ "$(echo "$AGENT" | tr '[:upper:]' '[:lower:]')" != "$(echo "$DEPLOYER" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "WARN: contract agent ($AGENT) != deployer ($DEPLOYER) — recordExecution beats will revert NotAgent" >&2
fi

# ephemeral owner — signs the relayed payloads, never needs gas
OWNER_KEYS=$(cast wallet new)
OWNER=$(echo "$OWNER_KEYS" | awk '/Address:/ {print $2}')
OWNER_PK=$(echo "$OWNER_KEYS" | awk '/Private key:/ {print $3}')
echo "policy:   $POLICY (chain $CHAIN_ID)"
echo "agent:    $AGENT"
echo "owner:    $OWNER (ephemeral)"
echo

USD_1=1000000; USD_15=15000000; USD_30=30000000; USD_45=45000000; USD_50=50000000; USD_500=500000000
LIST_HASH=$(cast keccak "sol|spyx|tslax")   # == packages/registry assetListHash(["spyx","tslax","sol"])
SPYX=$(cast keccak "spyx")
MEMECOIN=$(cast keccak "memecoin")
SEL_OVER_EXEC=$(cast sig "OverExecCap()")
SEL_OVER_PERIOD=$(cast sig "OverPeriodCap()")
SEL_NOT_ALLOWED=$(cast sig "AssetNotAllowed()")
SEL_NOT_ACTIVE=$(cast sig "NotActive()")

TXS=()

send_ok() { # label, sig, args...
  local label="$1"; shift
  local hash
  hash=$(cast send "$POLICY" "$@" --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" --async)
  local status
  status=$(cast receipt "$hash" status --rpc-url "$RPC") # prints e.g. "1 (success)"
  [[ "$status" == 1* ]] || { echo "FATAL: expected success for '$label' but tx $hash reverted" >&2; exit 1; }
  echo "✓ $label"
  echo "    $EXPLORER/tx/$hash"
  TXS+=("$label|$hash|success")
}

send_revert() { # label, expected-selector, sig, args...
  local label="$1" expected="$2"; shift 2
  # 1) simulate and assert the exact custom error
  local out
  out=$(cast call "$POLICY" "$@" --from "$DEPLOYER" --rpc-url "$RPC" 2>&1 || true)
  if ! echo "$out" | grep -qi "${expected#0x}"; then
    echo "FATAL: '$label' did not revert with expected selector $expected. Output:" >&2
    echo "$out" >&2
    exit 1
  fi
  # 2) land the reverted tx onchain (skip estimation with an explicit gas limit)
  local hash status
  hash=$(cast send "$POLICY" "$@" --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" \
    --gas-limit 200000 --async)
  status=$(cast receipt "$hash" status --rpc-url "$RPC")
  [[ "$status" == 0* ]] || { echo "FATAL: expected onchain revert for '$label' but status=$status" >&2; exit 1; }
  echo "✗ $label — reverted onchain as expected ($expected)"
  echo "    $EXPLORER/tx/$hash"
  TXS+=("$label|$hash|reverted:$expected")
}

# --- beat 0: createPlan($50/exec, $50/period, [spyx,tslax,sol]) ---
PLAN_ID=$(cast call "$POLICY" "nextPlanId()(uint256)" --rpc-url "$RPC")
NONCE=$(cast call "$POLICY" "authNonces(address)(uint256)" "$OWNER" --rpc-url "$RPC")
DIGEST=$(cast keccak "$(cast abi-encode "x(uint256,address,string,address,uint96,uint96,uint32,bytes32,uint256)" \
  "$CHAIN_ID" "$POLICY" "createPlan" "$AGENT" "$USD_50" "$USD_50" 604800 "$LIST_HASH" "$NONCE")")
SIG=$(cast wallet sign --private-key "$OWNER_PK" "$DIGEST")
send_ok "createPlan #$PLAN_ID — \$50/exec, \$50/period, [spyx,tslax,sol] (owner-signed, relayed)" \
  "createPlan(address,uint96,uint96,uint32,bytes32,string[],uint256,bytes)" \
  "$OWNER" "$USD_50" "$USD_50" 604800 "$LIST_HASH" '["sol","spyx","tslax"]' "$NONCE" "$SIG"

# --- beat 1: $15 SPYx — within policy ---
send_ok "recordExecution \$15 spyx" \
  "recordExecution(uint256,uint96,bytes32)" "$PLAN_ID" "$USD_15" "$SPYX"

# --- beat 2: $500 memecoin — blocked at the contract ---
send_revert "recordExecution \$500 memecoin" "$SEL_OVER_EXEC" \
  "recordExecution(uint256,uint96,bytes32)" "$PLAN_ID" "$USD_500" "$MEMECOIN"

# --- beat 2b: $30 memecoin — caps pass, allowlist blocks ---
send_revert "recordExecution \$30 memecoin" "$SEL_NOT_ALLOWED" \
  "recordExecution(uint256,uint96,bytes32)" "$PLAN_ID" "$USD_30" "$MEMECOIN"

# --- beat 3: $45 SPYx — period cap ($15 + $45 > $50) ---
send_revert "recordExecution \$45 spyx" "$SEL_OVER_PERIOD" \
  "recordExecution(uint256,uint96,bytes32)" "$PLAN_ID" "$USD_45" "$SPYX"

# --- beat 4: revoke — one tx zeroes authority (PS-F5-AC2) ---
NONCE=$(cast call "$POLICY" "authNonces(address)(uint256)" "$OWNER" --rpc-url "$RPC")
DIGEST=$(cast keccak "$(cast abi-encode "x(uint256,address,string,uint256,uint256)" \
  "$CHAIN_ID" "$POLICY" "revokePlan" "$PLAN_ID" "$NONCE")")
SIG=$(cast wallet sign --private-key "$OWNER_PK" "$DIGEST")
send_ok "revokePlanFor #$PLAN_ID (owner-signed, relayed)" \
  "revokePlanFor(uint256,uint256,bytes)" "$PLAN_ID" "$NONCE" "$SIG"

# --- beat 5: any further execution is dead ---
send_revert "recordExecution \$1 spyx after revoke" "$SEL_NOT_ACTIVE" \
  "recordExecution(uint256,uint96,bytes32)" "$PLAN_ID" "$USD_1" "$SPYX"

echo
echo "=== rehearsal transcript (plan #$PLAN_ID on $POLICY, chain $CHAIN_ID) ==="
for row in "${TXS[@]}"; do
  IFS='|' read -r label hash outcome <<<"$row"
  printf "%-72s %s\n    %s/tx/%s\n" "$label" "[$outcome]" "$EXPLORER" "$hash"
done
echo "PS-F5-AC1: the blocked beats failed AT THE CONTRACT (status 0 onchain, named custom errors)."
echo "PS-F5-AC2: one revoke transaction zeroed the agent's authority."
