import type { Address } from "viem";
import type { Venue } from "../../config/deployments";

/** Thrown when the backend has stopped intake (HTTP 503 or an explicit
 *  SERVICE_UNAVAILABLE error code). Rendered as "intake stopped" in the UI. */
export class ServiceUnavailableError extends Error {
  constructor(message = "Avail Escrow intake is unavailable") {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

/** Per-venue error codes inside a 200 /v2/quote response. */
export type QuoteVenueErrorCode =
  | "COULD_NOT_REACH"
  | "MIN_IN_AMOUNT_VIOLATION"
  | "MAX_IN_AMOUNT_VIOLATION"
  | "KYBER_ERROR"
  | "INTERNAL_SERVER_ERROR"
  | "SERVICE_UNAVAILABLE"
  | (string & {});

/** One venue's entry in a /v2/quote response. Every field except venue_name
 *  is optional-tolerant: failed venues omit fields entirely rather than
 *  nulling them (verified against the live backend). */
export interface AvailQuoteVenueV2 {
  venue_name: Venue | (string & {});
  amount_out?: string | null;
  /** Present only when slippage_bps was sent (we always send it). */
  amount_out_min?: string | null;
  /** Unix ms the venue produced the quote; null on failed venues. */
  quoted_at?: number | null;
  /** Token-approval spender for THIS venue: KalqiX escrow or Kyber router. */
  approval_address?: Address | null;
  /** OPAQUE. A KYBERSWAP quote's `routeSummary` must reach POST /intent
   *  byte-for-byte unchanged — never clone, re-shape, or re-order it. */
  venue_detail?: { routeSummary?: unknown } | null;
  /** KALQIX: the KalqiX-aligned input amount (may differ from requested). */
  amount_in?: string | null;
  asset_in_symbol?: string | null;
  asset_out_symbol?: string | null;
  /** KYBERSWAP metadata. NOTE: a SUCCESSFUL Kyber quote carries
   *  kyber_error_code 0 / "successfully" — failure detection must key on
   *  `error_code` / missing amount_out, never on these fields. */
  kyber_error_code?: number | string | null;
  kyber_error_message?: string | null;
  request_id?: string | null;
  error_code?: QuoteVenueErrorCode | null;
  error_message?: string | null;
}

/** Avail POST /v2/quote response. `quotes` is ordered best-first (descending
 *  amount_out); a 200 can still contain per-venue failures. */
export interface AvailQuoteV2Response {
  id: string;
  quotes: AvailQuoteVenueV2[];
  error_code: string | null;
  error_message: string | null;
}

/** Per-venue route-discovery options (`venue_options` in the spec). Only the
 *  KYBERSWAP fields we use are modelled; fee fields are server-controlled and
 *  rejected by the API, so they're deliberately absent. */
export interface VenueQuoteOption {
  name: Venue;
  /** Kyber source (dex) ids to route through exclusively. */
  includedSources?: string[];
}

interface Params {
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
  whitelistedVenues: Venue[];
  venueOptions?: VenueQuoteOption[];
}

/** The server's body limit for this endpoint. Exceeding it returns 413 with a
 *  text/plain body rather than the JSON error envelope, so we'd lose the error
 *  shape — cheaper to catch it here. A typical request with two
 *  `included_sources` lands at ~310 bytes, so this only bites if that list
 *  grows a lot. */
const MAX_BODY_BYTES = 512;

/** Thrown when the requested chain is outside the API's `chain_id` enum. */
export class BadChainIdError extends Error {
  constructor(message = "Chain not supported by this deployment") {
    super(message);
    this.name = "BadChainIdError";
  }
}

/**
 * Fetch a multi-venue quote from Avail's POST /v2/quote. CORS-open, so called
 * directly from the browser. Addresses are lowercased to match Avail's
 * case-sensitive asset registry (same as the intent client).
 *
 * JSON body, not query params. The pre-v0.2.0 client used GET with
 * serde_qs-style bracket keys, where `whitelisted_venues[]` and `venue_options`
 * were silently dropped by the server — which forced a client-side venue filter
 * and made source restriction unverifiable. Both bind correctly on POST
 * (verified 2026-08-10: `whitelisted_venues: ["HELLO"]` → 400
 * BAD_WHITELISTED_VENUES, and `included_sources` visibly constrains the
 * returned route), so those workarounds are gone.
 */
export async function getAvailQuoteV2(
  baseUrl: string,
  {
    chainId,
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    whitelistedVenues,
    venueOptions,
  }: Params
): Promise<AvailQuoteV2Response> {
  const body = JSON.stringify({
    chain_id: chainId,
    token_in: tokenIn.toLowerCase(),
    token_out: tokenOut.toLowerCase(),
    amount_in: amountIn.toString(),
    slippage_bps: slippageBps,
    ...(whitelistedVenues.length
      ? { whitelisted_venues: whitelistedVenues }
      : {}),
    ...(venueOptions?.length
      ? {
          venue_options: venueOptions.map((vo) => ({
            venue_name: vo.name,
            option: vo.includedSources?.length
              ? { included_sources: vo.includedSources }
              : null,
          })),
        }
      : {}),
  });

  const bytes = new TextEncoder().encode(body).length;
  if (bytes > MAX_BODY_BYTES) {
    throw new Error(
      `/v2/quote body is ${bytes} bytes, over the server's ${MAX_BODY_BYTES}-byte limit`
    );
  }

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v2/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const text = await res.text();
  let parsed: AvailQuoteV2Response;
  try {
    // Both success and request-level errors come back as JSON (with
    // error_code); the caller inspects error_code / quotes. 413/415/422 are
    // text/plain and fall through to the catch.
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
