/** Default UI slippage tolerance, in basis points (50 = 0.5%). */
export const DEFAULT_SLIPPAGE_BPS = 50;
export const SLIPPAGE_PRESETS_BPS = [10, 50, 100] as const;

/** Client-side quote time-to-live, measured from the quote's `quoted_at`.
 *  Conservative placeholder — the backend does not publish its staleness
 *  tolerance (strictest for KYBERSWAP routeSummaries), so we never submit a
 *  quote older than this and auto-re-quote instead. Tighten/relax once a
 *  confirmed backend tolerance exists. */
export const QUOTE_TTL_MS = 30_000;

/** Safety margin subtracted from a quote's calldata `expires_at_ms` before the
 *  harness will initiate a swap with it. Calldata carries its own clock,
 *  separate from QUOTE_TTL_MS — measured at ~60s on canary and testnet
 *  (2026-08-20) — and for KYBERSWAP that deadline is baked into the router
 *  calldata, so a transaction mined after it reverts.
 *
 *  This only governs whether we START; how long the user then spends in their
 *  wallet is outside our control, so a slow confirmation can still land past
 *  expiry. */
export const CALLDATA_EXPIRY_MARGIN_MS = 5_000;

/** Tokens the app allows on the KYBERSWAP path. /v2/quote quotes KYBERSWAP
 *  for any token and enforces no per-venue token/limit checks unless a
 *  /supported-token row exists — so the app owns this allowlist rather than
 *  relying on quote-time rejection. (POST /intent DOES validate per venue:
 *  unregistered tokens fail BAD_TOKEN_IN.) All harness tokens are allowed,
 *  including ETH — exercising the native-value path (transaction_value for
 *  ETH-in, WETH-unwrap for ETH-out) is part of what canary tests. */
export const KYBERSWAP_TOKEN_ALLOWLIST = ["USDC", "cbBTC", "ETH"] as const;
