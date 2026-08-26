import { useQuery } from "@tanstack/react-query";
import { getKyberQuote } from "../lib/kyber/client";
import type { ChainToken } from "../lib/tokens";
import { useActivityLog } from "../store/activityLog";
import { useActiveChain } from "./useSession";

// Benchmark, not the trade — a slow-moving reference, so refresh well below the
// 5s primary-quote cadence to avoid hammering a third-party API.
const KYBER_REFRESH_MS = 30_000;

interface Args {
  tokenIn: ChainToken | null;
  tokenOut: ChainToken | null;
  amountIn: bigint;
  enabled?: boolean;
}

/**
 * KyberSwap aggregator benchmark for the same swap, called directly rather than
 * through Avail. Disabled on chains without Kyber coverage (no `kyberSlug`,
 * e.g. Base Sepolia) — the caller should hide the comparison there rather than
 * show a stale or errored value.
 */
export function useKyberQuote({ tokenIn, tokenOut, amountIn, enabled = true }: Args) {
  const chain = useActiveChain();
  const slug = chain.kyberSlug;
  const log = useActivityLog((s) => s.push);

  return useQuery({
    queryKey: [
      "kyber",
      chain.id,
      tokenIn?.address,
      tokenOut?.address,
      amountIn.toString(),
    ],
    enabled: !!slug && !!tokenIn && !!tokenOut && enabled && amountIn > 0n,
    refetchInterval: KYBER_REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: 1,
    queryFn: async () => {
      const t0 = performance.now();
      const q = await getKyberQuote(
        slug!,
        tokenIn!.address,
        tokenOut!.address,
        amountIn
      );
      log({
        level: "info",
        channel: "API",
        message: `KyberSwap ${tokenIn!.symbol}→${tokenOut!.symbol} · ${q.amountOut} out`,
        details: `${Math.round(performance.now() - t0)}ms`,
      });
      return q;
    },
  });
}
