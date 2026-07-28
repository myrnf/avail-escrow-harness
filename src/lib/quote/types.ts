export interface KalqiXMarket {
  market_id: number;
  ticker: string;
  base_asset: string;
  quote_asset: string;
  base_asset_decimals: number;
  quote_asset_decimals: number;
  tick_size: string;
  step_size: string;
  min_quantity: string;
  min_trade_size: string;
  maker_fee: string;
  taker_fee: string;
  status: string;
  price_precision: number;
  quantity_precision: number;
}

export interface KalqiXMarketPrice {
  /** Best price in quote-asset base units per 1 base asset (raw, requires scaling). */
  price: string;
  /** Human-readable price string. */
  price_formatted?: string;
  side?: "BUY" | "SELL";
  ticker?: string;
}

import type { Address } from "viem";
import type { Venue } from "../../config/networks";

export type Side = "BUY" | "SELL";

/**
 * The quote we present to the user and pass into Avail Escrow.
 * All amounts are in **base units** of their respective tokens.
 */
export interface Quote {
  amountIn: bigint;
  amountInDecimals: number;
  amountOut: bigint;
  amountOutMin: bigint;
  amountOutDecimals: number;
  /** Price displayed in human units (quote per base, e.g. USDC per BTC). */
  priceHuman: number;
  /** null when the quote source doesn't expose a fee breakdown (Avail /quote
   *  returns amount_out already net of fees, with no separate fee field). */
  takerFeeBps: number | null;
  slippageBps: number;
  side: Side;
  ticker: string;
  /** Wall-clock instant the underlying price was fetched. */
  fetchedAt: number;
}

/** A `Quote` bound to the venue that produced it. The one shape execution
 *  code sees on every env — the legacy local path wraps its single KalqiX
 *  quote into one of these. */
export interface VenueQuote extends Quote {
  venue: Venue;
  /** Token-approval spender for this venue (KalqiX escrow or Kyber router). */
  approvalAddress: Address;
  /** The exact parsed `venue_detail` from /v2/quote — carried by reference so
   *  routeSummary reaches POST /intent verbatim. null for KALQIX/legacy. */
  venueDetail: { routeSummary?: unknown } | null;
  /** JSON snapshot of routeSummary taken at parse time; the pre-submit
   *  integrity assertion compares against it. */
  routeSummaryJson: string | null;
}

/** A venue that returned an error instead of a quote. */
export interface VenueFailure {
  venue: Venue | (string & {});
  code: string;
  message: string | null;
}

/** Result of one quote fetch across all enabled venues, best-first. */
export interface MultiQuote {
  /** /v2/quote response id; null on the legacy local path. */
  quoteId: string | null;
  quotes: VenueQuote[];
  failures: VenueFailure[];
}
