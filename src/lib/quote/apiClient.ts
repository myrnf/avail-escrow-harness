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

/** Route-discovery options for one venue (`venue_options` in the spec, which
 *  caps the array at a single entry). Only the KYBERSWAP fields we use are
 *  modelled; fee fields are server-controlled and rejected by the API, so
 *  they're deliberately absent. */
export interface VenueQuoteOption {
  venue: Venue;
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
  venueOption?: VenueQuoteOption;
}

/** The chain the API assumes when `chain_id` is absent. The legacy GET build
 *  predates the field entirely, so every query-string request is implicitly
 *  this chain. */
const LEGACY_IMPLIED_CHAIN_ID = 8453; // Base

/** Query-string form of the request, for envs still on the pre-POST build.
 *  TRANSITIONAL — delete once every env serves POST /v2/quote. */
function legacyQuoteUrl(baseUrl: string, p: Params): string {
  // The query form cannot carry chain_id, and the server defaults it to Base.
  // Falling back for any other chain would answer a Polygon request with a
  // Base quote — a plausible, well-formed, wrong answer, which is the worst
  // failure shape available here. Refuse instead.
  if (p.chainId !== LEGACY_IMPLIED_CHAIN_ID) {
    throw new BadChainIdError(
      `This deployment only serves the legacy GET /v2/quote, which cannot carry chain_id — it can only quote Base.`
    );
  }
  const parts = [
    `token_in=${p.tokenIn.toLowerCase()}`,
    `token_out=${p.tokenOut.toLowerCase()}`,
    `amount_in=${p.amountIn.toString()}`,
    `slippage_bps=${p.slippageBps}`,
  ];
  // Array params never worked on that build (its query deserializer can't
  // build sequences), so they're omitted here rather than sent uselessly —
  // callers filter venues client-side. Source restriction is simply
  // unavailable until the env serves POST.
  return `${baseUrl.replace(/\/$/, "")}/v2/quote?${parts.join("&")}`;
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
 * Request multi-venue quotes from Avail's POST /v2/quote. CORS-open and
 * preflight-enabled, so it's called directly from the browser. Addresses are
 * lowercased to match Avail's case-sensitive asset registry (same as the
 * intent client).
 *
 * A JSON body is what makes `whitelisted_venues` and `venue_options` usable
 * at all — the endpoint took query params until 2026-07-29, and that build's
 * deserializer could not construct sequences from a query string under any
 * encoding, so both array params were silently unreachable.
 *
 * `chain_id` selects the execution chain. The API defaults it to Base when
 * omitted, so it is always sent explicitly rather than relied upon.
 *
 * If an env still serves the older GET build it answers 405; we retry there as
 * a query request so quoting keeps working (without the array params, which
 * never functioned on it anyway). That fallback is refused for any chain but
 * Base — see legacyQuoteUrl. Delete both once every env is on POST.
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
    whitelistedVenues,
    venueOption,
  } = params;
  const body = JSON.stringify({
    chain_id: chainId,
    token_in: tokenIn.toLowerCase(),
    token_out: tokenOut.toLowerCase(),
    amount_in: amountIn.toString(),
    slippage_bps: slippageBps,
    // null (not []) means "all venues" per the spec; an empty allowlist would
    // be a request for nothing.
    whitelisted_venues: whitelistedVenues.length ? whitelistedVenues : null,
    venue_options: venueOption
      ? [
          {
            venue_name: venueOption.venue,
            option: venueOption.includedSources?.length
              ? { included_sources: venueOption.includedSources }
              : null,
          },
        ]
      : null,
  });

  // Over the limit the server answers 413 in text/plain, losing the JSON error
  // envelope — cheaper to catch here than to decode that.
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > MAX_BODY_BYTES) {
    throw new Error(
      `/v2/quote body is ${bytes} bytes, over the server's ${MAX_BODY_BYTES}-byte limit`
    );
  }

  let res = await fetch(`${baseUrl.replace(/\/$/, "")}/v2/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (res.status === 405) {
    res = await fetch(legacyQuoteUrl(baseUrl, params));
  }
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
