import type { Address } from "viem";

/** Where a token's metadata came from. Surfaced in the picker so a tester can
 *  tell a curated entry from one they pasted in. */
export type TokenSource = "native" | "kyber" | "quickswap" | "custom";

/**
 * A token on a specific chain. Replaces the old fixed
 * `"USDC" | "cbBTC" | "ETH"` union — identity is now (chainId, address), which
 * is what the API actually keys on.
 */
export interface ChainToken {
  chainId: number;
  /** For the native asset this is the 0xEeee… sentinel, not a real contract. */
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  /** Native chain currency — paid via msg.value, never approved or permitted.
   *  NOT necessarily ether: POL, BNB, AVAX, MON, S, HYPE, RON, MNT, XPL, XTZ
   *  and BERA are all native on chains we support. */
  isNative?: boolean;
  source: TokenSource;
  /** From Kyber's token list. Used as the EIP-2612 domain version fallback when
   *  a contract doesn't implement EIP-5267. */
  permitVersion?: string;
  isStable?: boolean;
  /** Present in QuickSwap's own default token list for this chain. Purely a
   *  marker — it never affects routing or quoting, only what the picker shows.
   *  See lib/tokens/quickswapList.ts for why the two lists diverge. */
  quickswapListed?: boolean;
}

export function sameToken(a: ChainToken, b: ChainToken): boolean {
  return (
    a.chainId === b.chainId &&
    a.address.toLowerCase() === b.address.toLowerCase()
  );
}

export function tokenKey(t: ChainToken): string {
  return `${t.chainId}:${t.address.toLowerCase()}`;
}
