import { ETH_SENTINEL, type ChainConfig } from "../../config/chains";
import type { ChainToken } from "./types";
import { isQuickswapListed } from "./quickswapList";

export * from "./types";
export { getKyberTokens, searchKyberTokens } from "./kyberTokens";
export { resolveTokenOnchain, TokenResolveError } from "./onchain";
export {
  isQuickswapListed,
  quickswapListSize,
  quickswapTokens,
} from "./quickswapList";

/**
 * The chain's native currency as a selectable token, addressed by the sentinel
 * both Avail and Kyber recognise.
 *
 * Symbol and decimals come from the chain definition, never from a constant —
 * native is ether on only 7 of the 18 supported chains (the rest are POL, BNB,
 * MON, S, HYPE, RON, MNT, XPL, XTZ, AVAX and BERA).
 */
export function nativeToken(c: ChainConfig): ChainToken {
  return {
    chainId: c.id,
    address: ETH_SENTINEL,
    symbol: c.chain.nativeCurrency.symbol,
    name: c.chain.nativeCurrency.name,
    decimals: c.chain.nativeCurrency.decimals,
    isNative: true,
    source: "native",
  };
}

/** Stamp the QuickSwap-listed marker. Applied centrally in mergeTokens and to
 *  search results, so every path into the picker is labelled consistently. */
export function markQuickswapListed(t: ChainToken): ChainToken {
  return isQuickswapListed(t.chainId, t.address)
    ? { ...t, quickswapListed: true }
    : t;
}

/**
 * Merge sources into one list, de-duplicated by address, native first.
 *
 * Earlier lists are AUTHORITATIVE for identity — address, symbol, name,
 * decimals, `isNative` and `source` all come from the first list that supplied
 * the token. Later lists only fill in *absent* presentational metadata
 * (`logoURI`, `permitVersion`, `isStable`).
 *
 * Whole-record precedence would be wrong in both directions: first-wins left
 * the native asset and the KalqiX tokens without the logos Kyber has for them,
 * while last-wins would let Kyber's plain row for the 0xEeee… sentinel
 * overwrite `isNative` — silently sending the native asset down the ERC-20
 * path, where balanceOf and approve both revert.
 */
export function mergeTokens(...lists: ChainToken[][]): ChainToken[] {
  const byAddress = new Map<string, ChainToken>();
  for (const list of lists) {
    for (const t of list) {
      const key = t.address.toLowerCase();
      const existing = byAddress.get(key);
      if (!existing) {
        byAddress.set(key, markQuickswapListed(t));
        continue;
      }
      byAddress.set(key, {
        ...existing,
        logoURI: existing.logoURI ?? t.logoURI,
        permitVersion: existing.permitVersion ?? t.permitVersion,
        isStable: existing.isStable ?? t.isStable,
      });
    }
  }
  return [...byAddress.values()].sort((a, b) => {
    if (a.isNative !== b.isNative) return a.isNative ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });
}
