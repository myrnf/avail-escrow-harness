import type { TokenSymbol } from "./tokens";
import type { Deployment } from "./deployments";

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
  network: Deployment,
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

/** Which KalqiX asset, if any, a token address corresponds to on this
 *  deployment. Tokens are addressed by (chainId, address) now, so this is how
 *  the KalqiX-only market map is reached from a generic selection. Returns null
 *  for anything KalqiX doesn't trade — i.e. almost everything off Base. */
export function kalqixSymbolFor(
  network: Deployment,
  address: string
): TokenSymbol | null {
  const lower = address.toLowerCase();
  for (const sym of ["USDC", "cbBTC", "ETH"] as const) {
    if (network.kalqixTokens[sym].toLowerCase() === lower) return sym;
  }
  return null;
}

/** The KalqiX market for a token pair given by address, or null when the pair
 *  isn't a USDC-quoted KalqiX market. */
export function routeForAddresses(
  network: Deployment,
  tokenInAddress: string,
  tokenOutAddress: string
): MarketRoute | null {
  const symIn = kalqixSymbolFor(network, tokenInAddress);
  const symOut = kalqixSymbolFor(network, tokenOutAddress);
  if (!symIn || !symOut) return null;
  return routeFor(network, symIn, symOut);
}
