import type { Address } from "viem";

export type TokenSymbol = "USDC" | "cbBTC";

export interface TokenInfo {
  symbol: TokenSymbol;
  name: string;
  address: Address;
  decimals: number;
  glyph: string;
  brand: string;
}

export const TOKENS: Record<TokenSymbol, TokenInfo> = {
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x94d655f6cc102d1e7e3f7a0e66fa604779ca8306",
    decimals: 6,
    glyph: "$",
    brand: "#2775CA",
  },
  cbBTC: {
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    address: "0xe58c5488de4d67dfb186ef955d412ff4473451a8",
    decimals: 8,
    glyph: "₿",
    brand: "#f7931a",
  },
};

export const TOKEN_LIST: TokenInfo[] = [TOKENS.USDC, TOKENS.cbBTC];

export function getToken(symbol: TokenSymbol): TokenInfo {
  return TOKENS[symbol];
}
