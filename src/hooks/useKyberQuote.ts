import { useQuery } from "@tanstack/react-query";
import { getKyberQuote } from "../lib/kyber/client";
import { getToken, type TokenSymbol } from "../config/tokens";
import { useActivityLog } from "../store/activityLog";
import { useActiveNetwork } from "./useActiveNetwork";

// Benchmark, not the trade — a slow-moving reference, so refresh well below the
// 5s primary-quote cadence to avoid hammering a third-party API.
const KYBER_REFRESH_MS = 30_000;

interface Args {
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: bigint;
  enabled?: boolean;
}

/**
 * KyberSwap aggregator benchmark for the same swap. Disabled on networks
 * without Kyber coverage (no `kyberChainSlug`, e.g. Base Sepolia testnet) — the
 * caller should hide the comparison there rather than show a stale/error value.
 */
export function useKyberQuote({ tokenIn, tokenOut, amountIn, enabled = true }: Args) {
  const network = useActiveNetwork();
  const slug = network.kyberChainSlug;
  const inInfo = getToken(network, tokenIn);
  const outInfo = getToken(network, tokenOut);
  const log = useActivityLog((s) => s.push);

  return useQuery({
    queryKey: [
      "kyber",
      network.key,
      inInfo.address,
      outInfo.address,
      amountIn.toString(),
    ],
    enabled: !!slug && enabled && amountIn > 0n,
    refetchInterval: KYBER_REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: 1,
    queryFn: async () => {
      const t0 = performance.now();
      const q = await getKyberQuote(slug!, inInfo.address, outInfo.address, amountIn);
      log({
        level: "info",
        channel: "API",
        message: `KyberSwap ${tokenIn}→${tokenOut} · ${q.amountOut} out`,
        details: `${Math.round(performance.now() - t0)}ms`,
      });
      return q;
    },
  });
}
