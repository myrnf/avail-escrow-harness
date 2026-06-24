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
