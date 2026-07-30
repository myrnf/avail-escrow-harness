# Avail Escrow concurrency load-test

Drives N wallets through the full swap flow (`POST /v2/quote` → permit/approve →
`POST /intent` → deposit tx → poll `GET /v2/intent/{id}` to settlement), and
reports per-intent timing so you can see whether concurrent intents settle in the
same time a lone swap takes, and whether any error out.

Executes on the **KALQIX** venue only. Pairs: **USDC ↔ cbBTC** and
**USDC ↔ ETH**.

### The ETH step size

KalqiX's `ETH_USDC` market quantises the ETH side to `step_size` 0.00000001 ETH.
Because ETH carries 18 decimals that's **10^10 wei**, so ETH amounts must be
multiples of 1e10 — unlike cbBTC, where the same step equals 1 base unit and
never binds. The orchestrator floors an unaligned `amount_in` and returns the
aligned value, and the script adopts whatever `amount_in` the quote echoes back
(the permit, the intent, and `msg.value` all have to agree with it, or the escrow
reverts). Where that alters the input, the report prints `(aligned from …)`.

ETH also has a **`min_quantity` of 0.0042 ETH** — smaller inputs are rejected
before they reach the market, so the script fails them early with a clear
message.

### Environments (`--env`, default `canary`)

| `--env` | Chain | Funds | Approval |
|---|---|---|---|
| `testnet` | Base Sepolia | fake (no `--go` needed) | **approve** (test tokens have no permit) |
| `canary` | Base mainnet | **real** (needs `--go`) | permit (EIP-2612) |
| `mainnet` | Base mainnet | **real** (needs `--go`) | permit (EIP-2612) |

Testnet uses a one-time `approve` per wallet (auto-skipped if allowance already
covers); canary/mainnet use a gasless permit folded into the single deposit tx.

## Setup

```bash
cp scripts/loadtest/wallets.example.json scripts/loadtest/wallets.json
# edit wallets.json — 10 entries of { "label", "privateKey" }.  (gitignored)
```

Each wallet needs ~11+ USDC (default swap size) and a little ETH for gas, on Base.

## Run (from repo root)

```bash
# 1. Preflight — USDC / cbBTC / ETH balances (free)
node scripts/loadtest/loadtest.mjs balances --env canary

# 2. Baseline — one swap, end-to-end, to establish the "typical" settle time
node scripts/loadtest/loadtest.mjs baseline --env canary --go
#    (then manually swap that wallet back so all wallets hold the input token)

# 3. Concurrent — all wallets fired together
node scripts/loadtest/loadtest.mjs concurrent --env canary --go

# Free dry-run of the whole thing on testnet (no --go needed):
node scripts/loadtest/loadtest.mjs concurrent --env testnet

# Production check on mainnet:
node scripts/loadtest/loadtest.mjs concurrent --env mainnet --go
```

### Direction

Add `--dir` (default `usdc-to-cbbtc`):

```bash
node scripts/loadtest/loadtest.mjs concurrent --dir cbbtc-to-usdc --go
```

- `usdc-to-cbbtc` → amount_in = **11 USDC** each (override with `AMOUNT_IN`).
- `cbbtc-to-usdc` → amount_in = **each wallet's full cbBTC balance** (swap it all
  back). Override with `AMOUNT_IN` (cbBTC base units) to use a fixed amount.
- `usdc-to-eth` → amount_in = **11 USDC** each. Drains the solver's **ETH**
  inventory and leaves the wallets holding ETH.
- `eth-to-usdc` → amount_in = **0.005 ETH** each, capped by the balance left
  after a 0.0003 ETH gas reserve, then floored to the step. Drains the solver's
  **USDC** inventory. Deliberately *not* the full balance: ETH is also the gas
  token, so emptying it would strand the wallet for the next run.

Since ETH is the gas token, the two ETH directions chain naturally: run
`usdc-to-eth` first (each 11 USDC buys well above the 0.0042 ETH minimum), then
`eth-to-usdc` to send it back.

### Draining solver inventory

Which side you drain is the direction's **output** token — the solver pays that
out. So `usdc-to-eth` depletes solver ETH, `eth-to-usdc` and `cbbtc-to-usdc`
deplete solver USDC. Useful for triggering the automated rebalancer: fire
`concurrent` repeatedly in one direction and watch the solver's on-chain and
KalqiX balances fall.

Note the market's **`min_trade_size` of 8 USDC** — a wallet holding less than
that can't trade at all, and `AMOUNT_IN` below it is rejected. Top such wallets
up or skip them with `--exclude`.

### Excluding wallets

`--exclude` skips wallets by label; the rest run. Zero-padding/case don't matter
(`w1` == `w01` == `W1`):

```bash
node scripts/loadtest/loadtest.mjs concurrent --exclude w1,w6 --go
```

Spending modes require `--go` (real funds). `concurrent` stages all intents
first, then bursts the deposits together so the execution-triggering event lands
in the same window.

## Config (env vars)

| Var | Default | Meaning |
|---|---|---|
| `BASE_RPC` | `https://rpcs.avail.so/base` | Base RPC for reads + sending txs |
| `AMOUNT_IN` | per-direction (see above) | Fixed input in the **input token's** base units, applied to all wallets |
| `SLIPPAGE_BPS` | `50` | Slippage tolerance |
| `WALLET` (flag `--wallet`) | `0` | Wallet index used for `baseline` |

## Reading the output

The key number is **`settle` = deposit-confirmed → SETTLED** (Avail's
solver + settlement time). Compare the concurrent run's `min/median/max settle`
against the baseline: if they're ~equal, concurrency isn't serializing. Any
terminal that isn't `SETTLED` is a failure to investigate — deposit + settlement
Basescan links are printed per intent.

Terminals come from the v2 lifecycle enums:

| Terminal | From | Meaning |
|---|---|---|
| `SETTLED` | `settlement_outcome: FUNDS_SETTLED` | output delivered — the success case |
| `UNLOCKED` | `FUNDS_UNLOCKED` | input refunded; the swap unwound |
| `SETTLE_FAILED` / `UNLOCK_FAILED` | `settlement_outcome: FAILURE` | split by `settlement_details.action` |
| `NO_MATCH` | `trade_outcome: NO_MATCH_FOUND` | no KalqiX fill — expect this first when inventory runs dry |
| `TTL_EXPIRED` | `trade_outcome: TTL_EXPIRED` | order aged out before filling |
| `ORDER_FAILED` | `trade_outcome: FAILURE` | trade leg errored |
| `EXPIRED` | `expired` with neither leg started | intent lapsed pre-execution |
| `TIMEOUT` | client-side | still undecided after 5 min of polling |

Settlement is checked before the trade leg, since a trade can succeed and
settlement still fail. When testing the rebalancer, `NO_MATCH` is the signal that
solver inventory is exhausted.
