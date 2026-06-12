import type { TokenSymbol } from "./tokens";
import type { NetworkConfig } from "./networks";

/**
 * Mapping from (tokenIn, tokenOut) → KalqiX market + side.
 * Every market is USDC-quoted: USDC is the quote leg, the other token is the
 * base. Buying base with USDC → BUY; selling base for USDC → SELL. The ticker
 * comes from the active network's per-asset map — testnet uses BTC_USDC for
 * cbBTC (Avail's solver handles the cbBTC↔BTC unification), canary/mainnet use
 * cbBTC_USDC; ETH is ETH_USDC everywhere.
 *
 * See PLAN.md §11.1 — load-bearing assumption, verified at app boot via /markets.
 */
export interface MarketRoute {
  ticker: string;
  side: "BUY" | "SELL";
}

/** The non-USDC (base) asset of a USDC-quoted pair, or null if neither side
 *  is USDC (no supported market). */
function baseAsset(
  tokenIn: TokenSymbol,
  tokenOut: TokenSymbol
): Exclude<TokenSymbol, "USDC"> | null {
  if (tokenIn === "USDC" && tokenOut !== "USDC") return tokenOut;
  if (tokenOut === "USDC" && tokenIn !== "USDC") return tokenIn;
  return null;
}

export function routeFor(
  network: NetworkConfig,
  tokenIn: TokenSymbol,
  tokenOut: TokenSymbol
): MarketRoute | null {
  const base = baseAsset(tokenIn, tokenOut);
  if (!base) return null;
  const ticker = network.kalqixMarketTickers[base];
  if (!ticker) return null;
  // Paying USDC buys the base; paying the base sells it for USDC.
  const side = tokenIn === "USDC" ? "BUY" : "SELL";
  return { ticker, side };
}
