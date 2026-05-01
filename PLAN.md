# Avail Escrow + KalqiX Swap Interface — Plan

**Status:** v0.1 draft, 2026-05-01.
**Scope:** v1 base interface, intentionally narrow, designed to expand into a testing harness.

---

## 1. Goal

Build a minimal browser swap interface that lets a connected wallet swap **USDC ↔ cbBTC** on **Base Sepolia** by:

1. Pulling a price from KalqiX (public market-price endpoint).
2. Showing the user a quote with a slippage-protected `amountOutMin`.
3. On approval, calling Avail Escrow `POST /intent` to get encoded calldata.
4. Submitting the deposit transaction via the user's wallet.
5. Polling `GET /intent/{id}` until terminal, surfacing the status.

This is **v1**. It is deliberately simple. It is not the harness — it is the substrate the harness will be built on.

## 2. Non-goals (for v1)

- No mainnet support. Testnet only.
- No EIP-2612 permit path (testnet USDC/cbBTC don't support it per Avail docs).
- No order-book walking / depth-aware quoting. Single-level best-bid/ask only.
- No faucet UI. Tester is assumed to hold Base Sepolia ETH + testnet USDC + testnet cbBTC already.
- No multi-asset support. USDC ↔ cbBTC only.
- No per-user history, persistence, or backend. Stateless frontend.
- No automated test suite yet. v1 is manually exercised; harness phase adds tests.

## 3. Stack

- **Vite + React + TypeScript** — fast iteration, no SSR baggage.
- **wagmi + viem** — wallet connection, ERC20 reads/writes, event watching, type-safe contract ABIs.
- **RainbowKit** — connect-button UI.
- **TanStack Query** — already a wagmi peer; used for KalqiX quote fetching and Avail intent polling.
- **No backend.** All API calls are direct browser → KalqiX / Avail Escrow. CORS willing.

## 4. Architecture

Three independent layers, each behind a clean interface so the harness can swap implementations:

```
src/
  quote/      KalqiX client + quote calculator
              - getMarketPrice(ticker, side) → raw price
              - quoteSwap(tokenIn, tokenOut, amountIn, slippageBps) → { amountOut, amountOutMin, feeBps, expiresAt }
              - interface QuoteSource so we can mock or swap in order-book walker later

  intent/     Avail Escrow client
              - createIntent({ tokenIn, tokenOut, amountIn, amountOut, permit? }) → { id, calldata, contractAddress }
              - getIntent(id) → { orderState, settlementState, … }
              - Strict TypeScript types matching the API spec, including the dual state machine

  chain/      wagmi/viem wiring
              - Base Sepolia chain config, RPC
              - readErc20Allowance, sendApprove
              - sendDepositTx (raw to: contractAddress, data: calldata)
              - watchIntentEvents (IntentDeposited / IntentSettled / IntentUnlocked)

  ui/         components
              - SwapForm (token picker, amount input, quote display, slippage knob)
              - StatusPanel (order_state + settlement_state, txn links)
              - ConnectButton (RainbowKit)

  config/     constants
              - Base Sepolia chain id (84532)
              - Token addresses (USDC, cbBTC sentinels per Avail docs)
              - Escrow contract address (0xe87e175EE35Ff028338a0c8D0F28c06427840a07)
              - KalqiX base URL (https://testnet-api.kalqix.com/v1)
              - KalqiX ticker map: { (USDC, cbBTC): "BTC_USDC" }
              - Default slippage (50 bps = 0.5%)
```

**Why these boundaries:** every external system (KalqiX, Avail Escrow, the chain) is one module deep. UI never imports a module from another external system directly — it goes through a typed interface. That's what makes harness expansion cheap later.

## 5. Token & market mapping

Per the Avail Escrow Integration Guide (v0.3) — Base Sepolia:

| Asset | Address | Decimals | Permit on testnet? |
|---|---|---|---|
| USDC  | `0x94d655f6cc102d1e7e3f7a0e66fa604779ca8306` | 6 | No |
| cbBTC | `0xe58c5488de4d67dfb186ef955d412ff4473451a8` | 8 | No |
| ETH (sentinel, unused in v1) | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` | 18 | n/a |

**KalqiX ticker assumed:** `BTC_USDC` (path-segment form per the spec example). cbBTC on the Avail side is treated as KalqiX-side BTC by the solver. **This is a load-bearing assumption — see §11.**

Side mapping:

- USDC → cbBTC ⇒ `side=BUY` on BTC_USDC (we pay quote, receive base)
- cbBTC → USDC ⇒ `side=SELL` on BTC_USDC (we sell base, receive quote)

## 6. KalqiX integration

**Base URL:** `https://testnet-api.kalqix.com/v1`. No auth needed for the public endpoints we're hitting.

Endpoints used in v1:

- `GET /markets/{ticker}` — once, on app load: pull `base_asset_decimals`, `quote_asset_decimals`, `taker_fee`, `tick_size`, `step_size`, `min_trade_size`. Cached.
- `GET /markets/{ticker}/market-price?side={BUY|SELL}` — every quote refresh: returns the current best ask (BUY) or best bid (SELL).

Quote calculation (v1, single-level):

```
USDC → cbBTC (BUY base):
  bestAsk          = market-price(side=BUY)             // USDC per BTC, base units of quote per base unit
  amountOutGross   = amountInUsdc / bestAsk             // base units of cbBTC
  amountOutNetFee  = amountOutGross * (1 - takerFee)    // takerFee from /markets call
  amountOutMin     = amountOutNetFee * (1 - slippage)

cbBTC → USDC (SELL base):
  bestBid          = market-price(side=SELL)
  amountOutGross   = amountInBtc * bestBid
  amountOutNetFee  = amountOutGross * (1 - takerFee)
  amountOutMin     = amountOutNetFee * (1 - slippage)
```

All math in BigInt with explicit decimal scaling. Never `Number`.

Quote freshness: re-fetch on a 5s timer while the form is mounted. Display a countdown. Refresh once more immediately before submission.

## 7. Avail Escrow integration

**Base URL:** `https://avail-escrow-test.availproject.org`.

`POST /intent` body (v1, no permit):

```json
{
  "token_in":  "0x…",
  "token_out": "0x…",
  "amount_in":  "<base units, decimal string>",
  "amount_out": "<amountOutMin, decimal string>",
  "client_intent_id": "<uuid for our logs>"
}
```

Response (success path) → `{ id, encoded_calldata, contract_address, solver_address }`.

Submit with wagmi: `useSendTransaction({ to: contract_address, data: encoded_calldata, value: 0n })`.

Status surfacing:
- Poll `GET /intent/{id}` every 2.5s.
- Treat `settlement_state.Settled` and `settlement_state.Unlocked` as terminal-success and terminal-refund respectively.
- Treat `Rejected` / `Failed` on either state machine as terminal-error.
- Stop polling when terminal.

## 8. Approval flow (v1)

Testnet tokens lack EIP-2612, so always use the two-tx approve path:

1. On token+amount selection, read `allowance(user, escrowContract)` for `tokenIn`.
2. If `allowance < amountIn`, render an "Approve" button. On click, call `approve(escrowContract, amountIn)`. Wait for receipt.
3. Once allowance is sufficient, render the "Swap" button. On click, do steps in §7.

**Do not** approve max-uint by default — approve exact `amountIn` per swap. (Easy to relax later behind a setting; safer default for a test harness.)

## 9. UI flow

```
[ Connect wallet ] → [ Pick direction: USDC→cbBTC ⇄ cbBTC→USDC ]
       ↓
[ Enter amountIn ]   ↻ live quote (best price, est out, min out, slippage knob, expiry)
       ↓
[ Approve if needed ] (only when ERC20 allowance < amountIn)
       ↓
[ Confirm swap ]  → POST /intent → wallet.sendTransaction
       ↓
[ Status panel ]   ↻ poll GET /intent/{id}
       ↓
  Terminal: success (link to settlement_tx_hash) | refunded (link to tx_hash) | error
```

Single page. No router needed in v1.

## 10. Error handling (v1)

| Failure | Behavior |
|---|---|
| KalqiX `/markets` 404 (ticker mismatch) | Fail loud at app boot. Banner: "KalqiX market mapping is wrong, see PLAN.md §11.1". |
| KalqiX `/market-price` transient error | Retry with exponential backoff (TanStack Query default). Show "Quote unavailable" after 3 fails. |
| Avail `POST /intent` 400 | Show the `error.message` verbatim under the swap button. |
| Avail `POST /intent` 422 / 500 | Generic "Service temporarily unavailable, please retry." |
| Deposit tx revert | Surface the revert reason from viem; common cause is allowance race or stale quote. Suggest re-quote. |
| Settlement `Unlocked` | Cheerful refund message + tx link. |
| Stuck >5 min | Show a "still processing" state. **Do not** expose `emergencyUnlock` in v1; keep it documented for harness phase. |

## 11. Load-bearing assumptions & verification strategy

These are the things that, if wrong, invalidate the design. Each must have an empirical verification step before we trust it.

### 11.1 KalqiX market mapping

**Assumption:** `BTC_USDC` exists on KalqiX testnet and is the market the Avail solver routes USDC ↔ cbBTC through.

**Risk if wrong:** every quote is bogus, every swap reverts on slippage.

**Verification:** at app boot, `GET /markets` and assert `BTC_USDC` is in the response with status `ACTIVE`. If absent, fail loud (§10). Confirm out-of-band with the Avail team that the solver does indeed use this market for cbBTC.

### 11.2 amount_out_min math matches what the contract enforces

**Assumption:** the contract's slippage check is `received_quote_token >= amount_out` (for BUY) or `received_base_token >= amount_out` (for SELL), in base units of the output token, no additional fee deduction.

**Risk if wrong:** every swap reverts even when our slippage looks generous.

**Verification:** first end-to-end test on Base Sepolia. Submit a small swap with a known quote and verify `amount_out` we sent matches what `IntentDeposited` event records as `amountOutMin`. If they diverge, the contract is doing extra accounting we need to model.

### 11.3 Quote staleness window

**Assumption:** A quote computed at second N is still valid (within slippage) at second N+5 when the user submits.

**Risk if wrong:** the quote drifts and reverts at settlement on KalqiX-side fill.

**Mitigation:** 0.5% default slippage (knob configurable to 0.1–5%), 5-second quote refresh, force refresh immediately before `POST /intent`, plus Avail's own ~60s server-side deadline. Unit test the quote calculator with a few "moved by X bps" scenarios.

### 11.4 Avail's published API spec is what's actually live

**Assumption:** the Notion-published API spec (v0.2.0) matches the deployed sandbox.

**Risk if wrong:** subtle field-name or type mismatches that surface at runtime.

**Verification:** smoke-test `POST /intent` with curl during phase 1 implementation; record the exact request/response shapes. Treat the Notion doc as informational, the actual response as authoritative for our types.

## 12. Phased implementation

Four phases, each with a clear "done" criterion. Do not start phase N+1 until phase N's criterion is met.

### Phase 1 — KalqiX quoting (no chain, no wallet)

- Scaffold Vite + React + TS + wagmi/viem + RainbowKit + TanStack Query.
- `quote/` module: `getMarket`, `getMarketPrice`, `quoteSwap`. BigInt-correct.
- A throwaway `<QuoteDebug>` page renders a live quote for both directions given a hard-coded amount.
- **Done when:** quote refreshes every 5s, both directions show a sane number with sane fees applied, and §11.1 verification passes.

### Phase 2 — Wallet + balances

- RainbowKit on Base Sepolia.
- Read user balances for USDC and cbBTC via wagmi `useReadContracts`.
- Read allowance for the Avail Escrow contract.
- "Approve" button using `useWriteContract`.
- **Done when:** I can connect a wallet, see my balances, and approve the escrow contract. No swap yet.

### Phase 3 — Swap end-to-end

- `intent/` module: `createIntent`, `getIntent`, fully typed.
- Wire `[Confirm swap]` → `POST /intent` → `useSendTransaction(deposit)` → polling `GET /intent/{id}`.
- StatusPanel renders dual state machine.
- **Done when:** a real testnet swap (USDC → cbBTC) round-trips and shows "Settled" with a Basescan link. §11.2 and §11.4 verifications happen here.

### Phase 4 — Hardening

- Sane error UX for every row in §10.
- Quote-expiry indicator in the form.
- Read-only "intent inspector" — paste an intent ID, see the full state. (First harness affordance — useful for debugging, no extra spec needed.)
- **Done when:** the table in §10 is fully implemented.

## 13. Forward-looking: harness hooks

Things v1 does **not** build but does **not preclude**. These shape the layering choices in §4 — explicitly noted so we don't paint ourselves into a corner.

- **Mock quote source.** `QuoteSource` interface so a test can inject a deterministic quote.
- **Mock intent client.** Same for `IntentClient` — replay recorded intent traces.
- **Scenario runner.** A page that scripts: connect → quote → swap → wait → assert. Drives the same UI components programmatically.
- **Order-book-walking quote.** Drop-in replacement for the single-level quote, same `quoteSwap` signature.
- **Permit codepath.** When mainnet tokens with EIP-2612 are added, the `intent/` module passes `permit` through; no UI overhaul needed.
- **Multi-asset support.** Token registry → market-mapping table. Adding an asset is one config edit + one ticker entry.
- **emergencyUnlock affordance.** "Rescue funds" button after the contract's 1-hour timeout, behind an "advanced" disclosure.
- **Event-watcher path.** Optional alternative to polling — same surface as `getIntent` but driven by `IntentDeposited` / `IntentSettled` / `IntentUnlocked`.

## 14. Open questions

- §11.1 — is `BTC_USDC` the right ticker, and does the Avail solver actually route through it? Confirm with the Avail team.
- Does the Avail Escrow sandbox API have CORS open for browser callers? If not, we need a tiny dev proxy. (Find out in phase 1.)
- Is RPC for Base Sepolia best handled with the public RPC, Alchemy, Infura, or something else? Picking one is a 30-second decision; flag it during phase 2 setup.
- Is there a known KalqiX testnet liquidity floor below which `market-price` returns nothing useful? Worth probing once during phase 1.

---

*Reference document. Update as decisions firm up. Treat §11 as the section to revisit before every phase boundary.*
