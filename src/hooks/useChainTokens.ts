import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { usePublicClient } from "wagmi";
import {
  getKyberTokens,
  markQuickswapListed,
  mergeTokens,
  nativeToken,
  quickswapListSize,
  quickswapTokens,
  resolveTokenOnchain,
  searchKyberTokens,
  type ChainToken,
} from "../lib/tokens";
import { useCustomTokenStore } from "../store/customTokens";
import { useActiveChain, useActiveDeployment } from "./useSession";
import { getToken, TOKEN_LIST_META } from "../config/tokens";

/**
 * Selectable tokens for the active chain: native first, then KyberSwap's
 * whitelist, then anything the tester pasted in.
 *
 * On a KalqiX-enabled chain the deployment's KalqiX assets are merged in ahead
 * of Kyber's list — testnet in particular has KalqiX-deployed USDC/cbBTC that
 * Kyber has never heard of, and they must stay selectable there.
 */
export function useChainTokens() {
  const chain = useActiveChain();
  const deployment = useActiveDeployment();
  const custom = useCustomTokenStore((s) => s.byChain[chain.id]);
  const addCustom = useCustomTokenStore((s) => s.add);
  const publicClient = usePublicClient({ chainId: chain.id });

  const kyber = useQuery({
    queryKey: ["kyber-tokens", chain.id],
    // Kyber has no coverage without a slug (Base Sepolia), so don't ask.
    enabled: !!chain.kyberSlug,
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: () => getKyberTokens(chain.id),
  });

  const kalqixTokens = useMemo((): ChainToken[] => {
    if (!chain.kalqixEnabled) return [];
    return TOKEN_LIST_META.filter((m) => !m.isNative).map((m) => {
      const info = getToken(deployment, m.symbol);
      return {
        chainId: chain.id,
        address: info.address,
        symbol: info.symbol,
        name: info.name,
        decimals: info.decimals,
        source: "kyber" as const,
        permitVersion: info.permitDomainVersion,
      };
    });
  }, [chain.id, chain.kalqixEnabled, deployment]);

  const tokens = useMemo(
    () =>
      mergeTokens(
        [nativeToken(chain)],
        kalqixTokens,
        // Ordered by AUTHORITY, not richness: native and the KalqiX assets
        // define identity (notably isNative), while Kyber and QuickSwap
        // contribute the logos and permit metadata those two lack. mergeTokens
        // fills absent fields rather than replacing records, so both hold.
        kyber.data ?? [],
        quickswapTokens(chain.id),
        custom ?? []
      ),
    [chain, kalqixTokens, kyber.data, custom]
  );

  /** Search Kyber's full registry, beyond the curated whitelist the browse
   *  list shows. Results that already appear locally are dropped so the picker
   *  doesn't show a token twice. */
  const searchRemote = useCallback(
    async (query: string): Promise<ChainToken[]> => {
      if (!chain.kyberSlug) return [];
      const found = await searchKyberTokens(chain.id, query);
      const known = new Set(tokens.map((t) => t.address.toLowerCase()));
      return found
        .filter((t) => !known.has(t.address.toLowerCase()))
        .map(markQuickswapListed);
    },
    [chain.kyberSlug, chain.id, tokens]
  );

  /** Resolve a pasted address on this chain and remember it. Throws
   *  TokenResolveError if there's no ERC-20 there. */
  const resolveAndAdd = useCallback(
    async (raw: string): Promise<ChainToken> => {
      if (!publicClient) throw new Error("No RPC client for this chain");
      const existing = tokens.find(
        (t) => t.address.toLowerCase() === raw.trim().toLowerCase()
      );
      if (existing) return existing;
      const t = await resolveTokenOnchain(publicClient, chain.id, raw);
      addCustom(t);
      return t;
    },
    [publicClient, chain.id, addCustom, tokens]
  );

  // Overlap between what we can offer and what QuickSwap lists. `listed` counts
  // only the ones present in BOTH — the gap against `quickswapTotal` is
  // QuickSwap tokens Kyber's whitelist doesn't carry (GHO on Base, etc.), which
  // are still reachable via search.
  const quickswapTotal = quickswapListSize(chain.id);
  const listedHere = useMemo(
    () => tokens.filter((t) => t.quickswapListed).length,
    [tokens]
  );

  return {
    tokens,
    quickswapTotal,
    quickswapListed: listedHere,
    isLoading: kyber.isLoading,
    /** True when Kyber serves no list for this chain — the picker should lead
     *  with the paste-an-address affordance instead of an empty list. */
    listUnavailable: !chain.kyberSlug || (kyber.isFetched && !kyber.data?.length),
    searchRemote,
    resolveAndAdd,
  };
}
