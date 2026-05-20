# Test-solver backend

Rust service that places KalqiX orders using one of two algorithms and
delivers the output back to the user from a pre-funded inventory. Built to
gather empirical data comparing "clear-min" (current Avail production
behavior) against "maximize-fill" (the proposed change) on real Base mainnet
liquidity.

See `../PLAN.md` and `../.claude/plans/so-i-want-to-atomic-kitten.md` for the
why. This README covers operating the backend.

## Architecture

```
frontend (/test-solver on Vercel)
   │
   │ POST /swap-request           — create swap, get recipient EOA
   │ POST /swap/{id}/deposit-tx   — user reports their USDC.transfer hash
   │ GET  /swap/{id}              — poll for state
   │ GET  /health                 — liveness + inventory snapshot
   ▼
this backend (axum)
   ├─► KalqiX REST (HMAC + EIP-191 order signature)
   └─► Base mainnet RPC (alloy)  — verify deposits, send payouts/refunds
```

Single swap state machine (see `src/state.rs::SwapStatus`):

```
REQUESTED → AWAITING_DEPOSIT → DEPOSIT_CONFIRMED → ORDER_PLACED →
   FILLED → PAYOUT_BROADCAST → COMPLETE
                                  │
                                  └─► FAILED (with refund_tx_hash)
```

## One-time setup

### 1. Generate a dedicated EOA

This key holds Base mainnet inventory **and** signs KalqiX orders. Treat as
production-grade. Don't reuse from another project.

```bash
# Suggested: cast (foundry)
cast wallet new

# Or with openssl:
openssl rand -hex 32
```

Save the hex private key (no 0x prefix) — goes into `SOLVER_PRIVATE_KEY`.

### 2. Register the EOA with KalqiX + mint an API key

Follow the [Authentication Guide](https://docs.kalqix.com/#/authentication).
The short version:

1. `GET /auth/nonce` → nonce
2. Sign a SIWE message with the EOA → `POST /auth/verify` → session JWT
3. `PUT /api-keys` with the raw JWT in `Authorization` header → `{api_key, api_secret}`

The secret is shown once — save both for the env vars.

### 3. Fund the inventory

Start small. Recommended for first runs:

| Surface | USDC | cbBTC |
|---|---|---|
| Solver EOA (Base mainnet) | $200 | 0.0025 BTC (~$200) |
| Solver KalqiX account     | $200 | 0.0025 BTC (~$200) |

To fund KalqiX: deposit from the EOA via the KalqiX dashboard (or
`POST /deposits` API). Funds in the EOA cover user payouts immediately; KalqiX
trades restock asynchronously.

### 4. Verify `/health`

After deploy:

```bash
curl -s https://<your-render-url>/health | jq
```

You should see both `usdc_eoa` and `cbbtc_eoa` populated. KalqiX-side
balances aren't auto-reported (would require extra auth); confirm via the
KalqiX dashboard.

## Local development

Need [rustup](https://rustup.rs/) installed. Then:

```bash
cp .env.example .env
# fill in KALQIX_API_KEY, KALQIX_API_SECRET, SOLVER_PRIVATE_KEY, etc.

cargo run --release
```

Server listens on `BIND_ADDR` (default `0.0.0.0:3000`).

For local frontend ↔ backend connectivity, set
`VITE_TEST_SOLVER_URL=http://localhost:3000` in the harness frontend's
`.env.local`.

## Deploy to Render free tier

1. Push this repo to GitHub (you already have it at myrnf/avail-escrow-harness).
2. https://render.com → **New** → **Web Service** → connect the GitHub repo.
3. Configure:
   - **Root Directory**: `backend`
   - **Environment**: Docker
   - **Region**: Oregon (sjc-ish) or your nearest
   - **Branch**: `main`
   - **Plan**: Free
4. **Environment variables** — copy each from `.env.example` and fill in your
   real values. Don't commit secrets.
5. Click **Create Web Service**. First build takes ~5-8 minutes.

Render assigns a URL like `https://avail-test-solver-xxx.onrender.com`.
That's what `VITE_TEST_SOLVER_URL` should point at on Vercel.

### Free-tier cold start

Free Render Web Services spin down after 15 minutes idle. First request after
spin-down takes 30-60s as the container cold-starts. Two cheap mitigations:

- **UptimeRobot ping** (free): hit `/health` every 10 minutes. Keeps the
  container warm.
- **Accept the cold start**: when you click "Confirm swap" the first time
  after a break, the wallet popup gives the backend enough time to wake up
  before the second POST lands.

### Fallback: cloudflared tunnel

If Render misbehaves or you want zero-latency cold-starts, run locally and
expose via cloudflared:

```bash
cargo run --release &
cloudflared tunnel --url http://localhost:3000
```

`cloudflared` prints a public `https://*.trycloudflare.com` URL. Point Vercel
at it. Free, no auth needed, perfect for short-lived testing windows.

## CORS

`ALLOWED_ORIGINS` is a strict allowlist (comma-separated). Include both your
Vercel production URL and the preview URL pattern. Wildcards aren't supported
— add each origin explicitly.

## Caps

`MAX_SWAP_USDC` and `MAX_SWAP_CBBTC` cap `amount_in` per swap, in base units.
Defaults are conservative ($50 each). Raise them once you've completed a
full end-to-end smoke test.

## Verification smoke tests

In order. Start with the smallest possible amounts.

1. **GET /health** — confirms env loaded, inventory readable.
2. **Tiny BUY · Algo A** (~$12 USDC → cbBTC). Confirms HMAC auth, EIP-191
   order signing, FOK fill, payout transfer.
3. **Tiny BUY · Algo B** (~$12 USDC → cbBTC). Should produce a visibly
   larger `net_payout` for the same `amount_in`.
4. **Tiny SELL** (0.00015 cbBTC → USDC). Should produce identical results
   under Algo A and Algo B.
5. **Refund test**: send a swap with an artificially high `amount_out_min`
   that forces a non-fill. Confirm `refund_tx_hash` lands and user EOA
   sees the full `amount_in` back.

## HMAC signature live verification

The canonicalization (`method | path | sorted-JSON-body | timestamp-ms`) and
EIP-191 wrapper (`{action, body, timestamp}` sorted JSON) are inferred from
KalqiX's HMAC + ethereum-signature guides. If your first POST `/orders` returns
`401`, the most likely causes are:

- Path mismatch: confirm whether `/v1` prefix is included in the canonical.
  Backend includes it by default; some KalqiX implementations don't.
- Body JSON key ordering: try toggling the recursive sort in
  `canonicalize_json` to top-level-only.
- Signature wrapper: try alternative shapes like `keccak256(payload)` instead
  of EIP-191 personal-sign.

Cheapest live check: a LIMIT BUY for 1 base unit at price 1, FOK. Won't match
anything (price absurdly low), but auth either accepts the order or returns
`401`. Iterate until accepted.

## Admin

`GET /admin/swaps` returns all in-memory swap records. Gated by
`ADMIN_BEARER_TOKEN`:

```bash
curl -H "Authorization: Bearer $ADMIN_BEARER_TOKEN" https://<url>/admin/swaps
```

Memory is wiped on restart — Render free tier restarts every spin-up. For
durable history, copy out the JSON before the container goes idle, or add
SQLite (out of scope for MVP).
