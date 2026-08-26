import list from "@quickswap-defi/token-list/build/quickswap-default.tokenlist.json";
import type { Address } from "viem";
import type { ChainToken } from "./types";

interface QsToken {
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
}

/**
 * QuickSwap's own default token list, used purely to MARK tokens — never as a
 * source of them.
 *
 * The distinction matters: Kyber's whitelist and QuickSwap's list are different
 * sets, and the gap runs both ways. GHO on Base is listed by QuickSwap and
 * routes through quickswap-v4, yet isn't in Kyber's whitelist at all; plenty of
 * Kyber-whitelisted tokens never appear in QuickSwap's UI. Showing which is
 * which is the point — it answers "how much of QuickSwap's token universe can
 * this API actually serve?"
 */
const byChain = new Map<number, Set<string>>();
for (const t of (list as { tokens: QsToken[] }).tokens) {
  let set = byChain.get(t.chainId);
  if (!set) {
    set = new Set();
    byChain.set(t.chainId, set);
  }
  set.add(t.address.toLowerCase());
}

/** How many tokens QuickSwap lists on a chain. 0 means they don't cover it. */
export function quickswapListSize(chainId: number): number {
  return byChain.get(chainId)?.size ?? 0;
}

export function isQuickswapListed(chainId: number, address: string): boolean {
  return byChain.get(chainId)?.has(address.toLowerCase()) ?? false;
}

/**
 * QuickSwap's listed tokens for a chain, as selectable entries.
 *
 * Merged into the browse list so ALL of QuickSwap's tokens are one click away,
 * not just the ones Kyber whitelists. On Base that's 20 additions on top of
 * Kyber's 334 — including QUICK itself, GHO and PEPE, which were previously
 * reachable only by searching or pasting an address. For a harness whose job is
 * to show QuickSwap their own token universe, that was the wrong default.
 *
 * Listing is not a promise of routability: a token here may still fail to
 * quote, which surfaces as a per-venue error on the card. That is a far better
 * failure than the token being invisible.
 */
export function quickswapTokens(chainId: number): ChainToken[] {
  return (list as { tokens: QsToken[] }).tokens
    .filter((t) => t.chainId === chainId)
    .map((t) => ({
      chainId: t.chainId,
      address: t.address as Address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      ...(t.logoURI ? { logoURI: t.logoURI } : {}),
      source: "quickswap" as const,
      quickswapListed: true,
    }));
}
