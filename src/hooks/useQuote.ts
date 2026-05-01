import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getMarket, getMarketPrice, quoteSwap } from "../lib/quote";
import { rawPriceFromMarketPrice, QuoteValidationError } from "../lib/quote/calc";
import { routeFor } from "../config/kalqix";
import { getToken, type TokenSymbol } from "../config/tokens";
import { useActivityLog } from "../store/activityLog";
import { useActiveNetwork } from "./useActiveNetwork";

const QUOTE_REFRESH_MS = 5_000;

export function useMarket(ticker: string) {
  const log = useActivityLog((s) => s.push);
  const network = useActiveNetwork();
  return useQuery({
    queryKey: ["market", network.key, ticker],
    queryFn: async () => {
      const t0 = performance.now();
      const m = await getMarket(network.kalqixBaseUrl, ticker);
      log({
        level: "info",
        channel: "API",
        message: `GET /markets/${ticker} · 200`,
        details: `${Math.round(performance.now() - t0)}ms`,
      });
      return m;
    },
    staleTime: 60_000,
  });
}

interface QuoteArgs {
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: bigint;
  slippageBps: number;
  enabled?: boolean;
}

export function useQuote({
  tokenIn,
  tokenOut,
  amountIn,
  slippageBps,
  enabled = true,
}: QuoteArgs) {
  const network = useActiveNetwork();
  const route = useMemo(() => routeFor(tokenIn, tokenOut), [tokenIn, tokenOut]);
  const market = useMarket(route?.ticker ?? "BTC_USDC");
  const log = useActivityLog((s) => s.push);

  const query = useQuery({
    queryKey: [
      "quote",
      network.key,
      route?.ticker,
      route?.side,
      tokenIn,
      tokenOut,
      amountIn.toString(),
      slippageBps,
    ],
    enabled: enabled && !!route && !!market.data && amountIn > 0n,
    refetchInterval: (q) =>
      q.state.error instanceof QuoteValidationError ? false : QUOTE_REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: (_n, err) => !(err instanceof QuoteValidationError),
    queryFn: async () => {
      if (!route || !market.data) throw new Error("Missing route/market");
      const t0 = performance.now();
      const price = await getMarketPrice(
        network.kalqixBaseUrl,
        route.ticker,
        route.side
      );
      const dt = Math.round(performance.now() - t0);
      log({
        level: "info",
        channel: "API",
        message: `GET /markets/${route.ticker}/market-price?side=${route.side} · 200`,
        details: `${dt}ms`,
      });
      const rawPrice = rawPriceFromMarketPrice(price);
      return quoteSwap({
        tokenIn: getToken(network, tokenIn),
        tokenOut: getToken(network, tokenOut),
        amountIn,
        side: route.side,
        ticker: route.ticker,
        market: market.data,
        rawPrice,
        slippageBps,
        fetchedAt: Date.now(),
      });
    },
  });

  return {
    ...query,
    market,
    route,
  };
}
