import type { Address } from "viem";
import type { Venue } from "../../config/networks";

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

/** Avail GET /v2/quote response. `quotes` is ordered best-first (descending
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
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
  whitelistedVenues: Venue[];
  venueOptions?: VenueQuoteOption[];
}

/**
 * Fetch a multi-venue quote from Avail's GET /v2/quote. CORS-open like v1, so
 * called directly from the browser. Addresses are lowercased to match Avail's
 * case-sensitive asset registry (same as the intent client).
 *
 * The two array params (`whitelisted_venues`, `venue_options`) are sent with
 * literal-bracket, serde_qs-style keys — the only shape that doesn't 400 on
 * the deployed build. Brackets are left unencoded on purpose: URLSearchParams
 * would percent-encode them to %5B/%5D, which the server reads as part of the
 * key name.
 *
 * KNOWN GAP (canary + testnet, verified 2026-07-29): neither array param
 * reaches the handler on the deployed build. Non-bracketed values 400 with
 * "invalid type: string, expected a sequence"; bracketed values are dropped
 * silently — `whitelisted_venues[]=HELLO` returns 200 instead of the spec's
 * BAD_WHITELISTED_VENUES, and a bogus venue_options field returns 200 despite
 * `additionalProperties: false`. Scalars (slippage_bps) parse fine and JSON
 * bodies handle arrays fine, so it's query-string sequences specifically.
 * Callers must therefore verify the response rather than trust the request:
 * see honorsSources() for the KYBERSWAP route check, and the client-side
 * venue filter in useQuote. Both become no-ops once the params take effect.
 */
export async function getAvailQuoteV2(
  baseUrl: string,
  {
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    whitelistedVenues,
    venueOptions,
  }: Params
): Promise<AvailQuoteV2Response> {
  const parts = [
    `token_in=${tokenIn.toLowerCase()}`,
    `token_out=${tokenOut.toLowerCase()}`,
    `amount_in=${amountIn.toString()}`,
    `slippage_bps=${slippageBps}`,
  ];
  whitelistedVenues.forEach((v) => parts.push(`whitelisted_venues[]=${v}`));
  venueOptions?.forEach((vo, i) => {
    parts.push(`venue_options[${i}][name]=${vo.name}`);
    vo.includedSources?.forEach((s, j) =>
      parts.push(
        `venue_options[${i}][option][included_sources][${j}]=${encodeURIComponent(s)}`
      )
    );
  });
  const res = await fetch(
    `${baseUrl.replace(/\/$/, "")}/v2/quote?${parts.join("&")}`
  );
  const text = await res.text();
  let body: AvailQuoteV2Response;
  try {
    // Both success and request-level errors come back as JSON (with
    // error_code); the caller inspects error_code / quotes.
    body = JSON.parse(text) as AvailQuoteV2Response;
  } catch {
    if (res.status === 503) throw new ServiceUnavailableError();
    throw new Error(`/v2/quote ${res.status}: ${text.slice(0, 160)}`);
  }
  if (res.status === 503 || body.error_code === "SERVICE_UNAVAILABLE") {
    throw new ServiceUnavailableError(body.error_message ?? undefined);
  }
  return body;
}
