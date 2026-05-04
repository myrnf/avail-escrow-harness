import type { TokenSymbol } from "./tokens";
import type { NetworkConfig } from "./networks";

/**
 * Mapping from (tokenIn, tokenOut) → KalqiX market + side.
 * The market ticker comes from the active network — testnet uses BTC_USDC,
 * canary/mainnet use cbBTC_USDC. Avail's solver handles the cbBTC<->BTC
 * unification on testnet under the hood.
 *
 * See PLAN.md §11.1 — load-bearing assumption, verified at app boot via /markets.
 */
export interface MarketRoute {
  ticker: string;
  side: "BUY" | "SELL";
}

export function routeFor(
  network: NetworkConfig,
  tokenIn: TokenSymbol,
  tokenOut: TokenSymbol
): MarketRoute | null {
  if (tokenIn === "USDC" && tokenOut === "cbBTC") {
    return { ticker: network.kalqixMarketTicker, side: "BUY" };
  }
  if (tokenIn === "cbBTC" && tokenOut === "USDC") {
    return { ticker: network.kalqixMarketTicker, side: "SELL" };
  }
  return null;
}
