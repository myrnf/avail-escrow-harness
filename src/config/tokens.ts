import type { Address } from "viem";
import type { NetworkConfig } from "./networks";

export type TokenSymbol = "USDC" | "cbBTC";

/** Token metadata that doesn't vary by network: decimals, symbol, brand, glyph,
 *  and the canonical EIP-712 domain version for permit (used as fallback when
 *  the contract doesn't expose eip712Domain() per EIP-5267). */
export interface TokenMeta {
  symbol: TokenSymbol;
  name: string;
  decimals: number;
  glyph: string;
  brand: string;
  permitDomainVersion: string;
}

/** Combined view: metadata + the per-network address and permit support. */
export interface TokenInfo extends TokenMeta {
  address: Address;
  supportsPermit: boolean;
}

export const TOKEN_META: Record<TokenSymbol, TokenMeta> = {
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    glyph: "$",
    brand: "#2775CA",
    // Circle's FiatTokenV2_2 (mainnet/canary USDC) signs with version "2".
    permitDomainVersion: "2",
  },
  cbBTC: {
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    decimals: 8,
    glyph: "₿",
    brand: "#f7931a",
    // OpenZeppelin's ERC20Permit default.
    permitDomainVersion: "1",
  },
};

export const TOKEN_LIST_META: TokenMeta[] = [TOKEN_META.USDC, TOKEN_META.cbBTC];

export function getToken(
  network: NetworkConfig,
  symbol: TokenSymbol
): TokenInfo {
  return {
    ...TOKEN_META[symbol],
    address: network.tokens[symbol],
    supportsPermit: network.permitSupport[symbol],
  };
}
