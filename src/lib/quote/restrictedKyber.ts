import type { Address } from "viem";
import { getKyberRoute } from "../kyber/client";
import { impliedUsdcPrice } from "./calc";
import type { Side, VenueFailure, VenueQuote } from "./types";

// ─────────────────────────────────────────────────────────────────────────
// ADAPTER — the swap point for source-restricted KYBERSWAP quoting.
//
// Avail's /v2/quote cannot currently be constrained to specific aggregator
// sources: `venue_options` is accepted but has no effect (verified against
// canary 2026-07-29 — it silently swallows any value, including junk, and
// routing never changes). So a restricted route is fetched from KyberSwap
// directly and handed to POST /intent as `venue_detail`, which the backend
// passes through to Kyber's build step verbatim — no route discovery of its
// own, so execution inherits the restriction from the quote.
//
// When the backend wires `includedSources` through, delete this module and
// pass the sources to getAvailQuoteV2 instead. Nothing else has to change:
// the VenueQuote this returns is shape-identical to a parsed backend quote.
// ─────────────────────────────────────────────────────────────────────────

interface Args {
  chainSlug: string;
  /** Aggregator dex ids to route through exclusively. */
  sources: string[];
  tokenIn: Address;
  tokenOut: Address;
  tokenInIsUsdc: boolean;
  amountIn: bigint;
  slippageBps: number;
  inDecimals: number;
  outDecimals: number;
  side: Side;
  ticker: string;
}

export async function fetchRestrictedKyberQuote(
  a: Args
): Promise<{ quote: VenueQuote } | { failure: VenueFailure }> {
  let route;
  try {
    route = await getKyberRoute(
      a.chainSlug,
      a.tokenIn,
      a.tokenOut,
      a.amountIn,
      a.sources
    );
  } catch (e) {
    return {
      failure: {
        venue: "KYBERSWAP",
        code: "NO_RESTRICTED_ROUTE",
        message:
          e instanceof Error ? e.message : "No route through the chosen pools.",
      },
    };
  }

  const amountOut = route.amountOut;
  if (amountOut <= 0n) {
    return {
      failure: {
        venue: "KYBERSWAP",
        code: "NO_RESTRICTED_ROUTE",
        message: "No route through the chosen pools.",
      },
    };
  }
  // Kyber's /routes takes no slippage param — apply the user's tolerance
  // locally, the same formula the backend uses for amount_out_min.
  const amountOutMin =
    (amountOut * BigInt(10_000 - a.slippageBps)) / 10_000n;

  return {
    quote: {
      amountIn: a.amountIn,
      amountInDecimals: a.inDecimals,
      amountOut,
      amountOutMin,
      amountOutDecimals: a.outDecimals,
      priceHuman: impliedUsdcPrice({
        tokenInIsUsdc: a.tokenInIsUsdc,
        amountIn: a.amountIn,
        amountOut,
        inDecimals: a.inDecimals,
        outDecimals: a.outDecimals,
      }),
      takerFeeBps: null,
      slippageBps: a.slippageBps,
      side: a.side,
      ticker: a.ticker,
      // Just fetched — the route's own `timestamp` is seconds-precision, and
      // the TTL guard wants the instant we received it.
      fetchedAt: Date.now(),
      venue: "KYBERSWAP",
      approvalAddress: route.routerAddress,
      // Wrapped exactly as the backend nests it, carried by reference so it
      // reaches POST /intent verbatim.
      venueDetail: { routeSummary: route.routeSummary },
      routeSummaryJson: JSON.stringify(route.routeSummary),
    },
  };
}
