import type { Address } from "viem";
import type { NetworkConfig } from "./networks";

export type TokenSymbol = "USDC" | "cbBTC";

/** Token metadata that doesn't vary by network: decimals, symbol, brand, glyph. */
export interface TokenMeta {
  symbol: TokenSymbol;
  name: string;
  decimals: number;
  glyph: string;
  brand: string;
}

/** Combined view: metadata + the address for the active network. */
export interface TokenInfo extends TokenMeta {
  address: Address;
}

export const TOKEN_META: Record<TokenSymbol, TokenMeta> = {
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    glyph: "$",
    brand: "#2775CA",
  },
  cbBTC: {
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    decimals: 8,
    glyph: "₿",
    brand: "#f7931a",
  },
};

export const TOKEN_LIST_META: TokenMeta[] = [TOKEN_META.USDC, TOKEN_META.cbBTC];

export function getToken(
  network: NetworkConfig,
  symbol: TokenSymbol
): TokenInfo {
  return { ...TOKEN_META[symbol], address: network.tokens[symbol] };
}
