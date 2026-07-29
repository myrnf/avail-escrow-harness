# Avail Escrow concurrency load-test

Drives N wallets through the full swap flow (`GET /quote` → EIP-2612 permit →
`POST /intent` → deposit tx → poll to settlement) on **Canary**, and reports
per-intent timing so you can see whether concurrent intents settle in the same
time a lone swap takes, and whether any error out.

Pair: **USDC → cbBTC** (cbBTC step size is 1 base unit, so it avoids the ETH
step-size issue). Approval via **permit** (Canary USDC supports EIP-2612).

## Setup

```bash
cp scripts/loadtest/wallets.example.json scripts/loadtest/wallets.json
# edit wallets.json — 10 entries of { "label", "privateKey" }.  (gitignored)
```

Each wallet needs ~11+ USDC (default swap size) and a little ETH for gas, on Base.

## Run (from repo root)

```bash
# 1. Preflight — balances / permit nonces (free, no spend)
node scripts/loadtest/loadtest.mjs balances

# 2. Baseline — one swap, end-to-end, to establish the "typical" settle time
node scripts/loadtest/loadtest.mjs baseline --go
#    (then manually swap that wallet's cbBTC back to USDC so all 10 hold USDC)

# 3. Concurrent — all wallets fired together
node scripts/loadtest/loadtest.mjs concurrent --go
```

Spending modes require `--go` (real funds). `concurrent` stages all intents
first, then bursts the deposits together so the execution-triggering event lands
in the same window.

## Config (env vars)

| Var | Default | Meaning |
|---|---|---|
| `BASE_RPC` | `https://rpcs.avail.so/base` | Base RPC for reads + sending txs |
| `AMOUNT_IN` | `11000000` | Swap input in USDC base units (11 USDC) |
| `SLIPPAGE_BPS` | `50` | Slippage tolerance |
| `WALLET` | `0` | Wallet index used for `baseline` |

## Reading the output

The key number is **`settle` = deposit-confirmed → SETTLED** (Avail's
solver + settlement time). Compare the concurrent run's `min/median/max settle`
against the baseline: if they're ~equal, concurrency isn't serializing. Any
terminal that isn't `SETTLED` (`UNLOCKED`, `FAILED_TO_SETTLE`, `EXPIRED`,
`ORDER_FAILED`, `TIMEOUT`) is a failure to investigate — deposit + settlement
Basescan links are printed per intent.
