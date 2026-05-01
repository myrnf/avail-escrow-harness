import type { TokenSymbol } from "./tokens";

/**
 * Mapping from (tokenIn, tokenOut) → KalqiX market + side.
 * KalqiX uses BTC as the base ticker; the Avail solver routes cbBTC through it.
 * Same routing on testnet and mainnet.
 *
 * See PLAN.md §11.1 — load-bearing assumption, verified at app boot via /markets.
 */
export interface MarketRoute {
  ticker: string;
  side: "BUY" | "SELL";
}

export function routeFor(
  tokenIn: TokenSymbol,
  tokenOut: TokenSymbol
): MarketRoute | null {
  if (tokenIn === "USDC" && tokenOut === "cbBTC") {
    return { ticker: "BTC_USDC", side: "BUY" };
  }
  if (tokenIn === "cbBTC" && tokenOut === "USDC") {
    return { ticker: "BTC_USDC", side: "SELL" };
  }
  return null;
}

export const SUPPORTED_MARKETS = ["BTC_USDC"] as const;
