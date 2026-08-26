import type { Address, Hex } from "viem";
import type { Venue } from "../../config/deployments";

/** Thrown when the backend has stopped intake (HTTP 503 or an explicit
 *  SERVICE_UNAVAILABLE error code). Rendered as "intake stopped" in the UI. */
export class ServiceUnavailableError extends Error {
  constructor(message = "Avail Escrow intake is unavailable") {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

/** Thrown when the requested chain is outside the deployment's `chain_id` enum. */
export class BadChainIdError extends Error {
  constructor(message = "Chain not supported by this deployment") {
    super(message);
    this.name = "BadChainIdError";
  }
}

/** Venue-level error codes inside a 200 /v2/quote response. Widened with
 *  `& {}` so codes from a newer backend still type-check. */
export type QuoteVenueErrorCode =
  | "COULD_NOT_REACH"
  | "AMOUNT_IN_BELOW_MIN_AMOUNT"
  | "AMOUNT_IN_ABOVE_MAX_AMOUNT"
  | "MIN_TRADE_VIOLATION"
  | "MAX_TRADE_VIOLATION"
  | "MIN_QTY_VIOLATION"
  | "STEP_SIZE_VIOLATION"
  | "NO_ASSET_FOUND_FOR_TOKEN_IN"
  | "NO_ASSET_FOUND_FOR_TOKEN_OUT"
  | "NO_MARKET_FOUND"
  | "UNSUPPORTED_CHAIN"
  | "VENUE_ERROR"
  | "INTERNAL_SERVER_ERROR"
  | "SERVICE_UNAVAILABLE"
  | (string & {});

/**
 * KYBERSWAP execution context: the opaque route summary plus the chain, router,
 * exact slippage and origin used to build the transaction.
 *
 * OPAQUE. `routeSummary` must reach POST /intent byte-for-byte unchanged —
 * never clone, re-shape, or re-order it.
 */
export interface KyberswapExecutionContext {
  chainId: number;
  routeSummary?: unknown;
  routerAddress: Address;
  slippageBps: number | null;
  origin: Address | null;
}

/** `details.calldata` — an executable transaction, present only when the
 *  request asked for it via `create_calldata`. The server reserves an intent id
 *  alongside it and retains both until POST /intent consumes them (by
 *  `quote_id` + `venue`) or `expires_at_ms` passes. Nothing is persisted until
 *  that consume call, so polling with calldata on leaves no intent behind. */
export interface QuoteCalldataV2 {
  /** Unix ms. Hard deadline — a second clock, independent of quote staleness.
   *  Measured at ~60s on canary and testnet (2026-08-20). */
  expires_at_ms: number;
  encoded_calldata: Hex;
  /** KALQIX escrow, or KYBERSWAP router. */
  contract_address: Address;
  /** KALQIX only. */
  solver_address?: Address | null;
  /** KYBERSWAP only: native value the router tx must carry. */
  transaction_value?: string | null;
}

/** Per-venue `details`. Success and failure share the same JSON slot, so
 *  they're modelled as one optional-tolerant shape and discriminated on
 *  `error_code`. */
export interface QuoteDetailsV2 {
  error_code?: QuoteVenueErrorCode | null;
  error_message?: string | null;
  /** Token-approval spender: KALQIX escrow or KYBERSWAP router. */
  approval_address?: Address | null;
  /** Present only when slippage_bps was sent (we always send it). */
  amount_out_min?: string | null;
  calldata?: QuoteCalldataV2 | null;
  // KALQIX
  /** The KalqiX-aligned input amount, which may differ from the requested one. */
  amount_in?: string | null;
  asset_in_symbol?: string | null;
  asset_out_symbol?: string | null;
  // KYBERSWAP
  execution_context?: KyberswapExecutionContext | null;
  /** NOTE: a SUCCESSFUL Kyber quote carries kyber_code 0 / "success" — failure
   *  detection must key on `error_code`, never on these fields. */
  kyber_code?: number | string | null;
  kyber_message?: string | null;
  kyber_request_id?: string | null;
}

/** One venue's entry in a /v2/quote response. */
export interface AvailQuoteVenueV2 {
  venue: Venue | (string & {});
  amount_out?: string | null;
  /** Unix ms the venue produced the quote; null on failed venues. */
  quoted_at_ms?: number | null;
  details?: QuoteDetailsV2 | null;
}

/** Avail POST /v2/quote response. `quotes` is ordered best-first (descending
 *  amount_out); a 200 can still contain per-venue failures. */
export interface AvailQuoteV2Response {
  quote_id: string;
  quotes: AvailQuoteVenueV2[];
  error_code: string | null;
  error_message: string | null;
}

interface Params {
  /** The chain to QUOTE against, which is not always the chain we broadcast on
   *  — see `Deployment.quoteChainId`. */
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
  venues: Venue[];
  /** Kyber source (dex) ids to route through exclusively. */
  includedSources?: string[];
  /** Ask for KALQIX deposit calldata in the quote. A permit, if given, is baked
   *  into that calldata — which is why a permit swap cannot pre-fetch: the
   *  signature would have to precede the thing it signs. */
  kalqixCalldata?: { permit?: string | null } | null;
  /** Ask for KYBERSWAP router calldata. `user_wallet` is REQUIRED by the API,
   *  so this is only available once a wallet is connected. */
  kyberCalldata?: { userWallet: Address } | null;
}

/** Documented Axum cap for this endpoint. Over it the server answers 413 in
 *  text/plain, losing the JSON error envelope — cheaper to catch here than to
 *  decode that. A previous 512-byte value here was simply wrong: canary
 *  accepted an 80KB body with a 200 (verified 2026-08-20). This is a bound on
 *  a runaway included_sources list, not a limit real requests approach. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Request multi-venue quotes from Avail's POST /v2/quote. CORS-open and
 * preflight-enabled, so it's called directly from the browser. Addresses are
 * lowercased to match Avail's case-sensitive asset registry (same as the
 * intent client).
 *
 * The request body is validated with `deny_unknown_fields`: a stale key fails
 * the whole request with a 422 rather than being ignored (this is exactly how
 * the pre-0.2.0 `whitelisted_venues` broke every quote). Per-venue option
 * objects are therefore omitted entirely when unused, never sent as null.
 */
export async function getAvailQuoteV2(
  baseUrl: string,
  params: Params
): Promise<AvailQuoteV2Response> {
  const {
    chainId,
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    venues,
    includedSources,
    kalqixCalldata,
    kyberCalldata,
  } = params;

  const kyberswap =
    includedSources?.length || kyberCalldata
      ? {
          ...(includedSources?.length
            ? { route_options: { included_sources: includedSources } }
            : {}),
          ...(kyberCalldata
            ? {
                create_calldata: {
                  user_wallet: kyberCalldata.userWallet.toLowerCase(),
                },
              }
            : {}),
        }
      : undefined;

  const body = JSON.stringify({
    chain_id: chainId,
    token_in: tokenIn.toLowerCase(),
    token_out: tokenOut.toLowerCase(),
    amount_in: amountIn.toString(),
    slippage_bps: slippageBps,
    // null (not []) means "all venues" per the spec; an empty allowlist would
    // be a request for nothing.
    venues: venues.length ? venues : null,
    ...(kalqixCalldata
      ? {
          kalqix: {
            create_calldata: kalqixCalldata.permit
              ? { permit: kalqixCalldata.permit }
              : {},
          },
        }
      : {}),
    ...(kyberswap ? { kyberswap } : {}),
  });

  const bytes = new TextEncoder().encode(body).length;
  if (bytes > MAX_BODY_BYTES) {
    throw new Error(
      `/v2/quote body is ${bytes} bytes, over the server's ${MAX_BODY_BYTES}-byte limit`
    );
  }

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v2/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await res.text();
  let parsed: AvailQuoteV2Response;
  try {
    // Quote-level and request-level failures come back as JSON carrying
    // error_code; the caller inspects error_code / quotes. Malformed-request
    // statuses (413 body too large, 415 wrong content-type, 422 bad shape,
    // and JSON-syntax 400s) answer in text/plain and land in the catch.
    parsed = JSON.parse(text) as AvailQuoteV2Response;
  } catch {
    if (res.status === 503) throw new ServiceUnavailableError();
    throw new Error(`/v2/quote ${res.status}: ${text.slice(0, 160)}`);
  }
  if (res.status === 503 || parsed.error_code === "SERVICE_UNAVAILABLE") {
    throw new ServiceUnavailableError(parsed.error_message ?? undefined);
  }
  if (parsed.error_code === "BAD_CHAIN_ID") {
    throw new BadChainIdError(parsed.error_message ?? undefined);
  }
  return parsed;
}
