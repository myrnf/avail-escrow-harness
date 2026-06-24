import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getMarket, getMarketPrice, quoteSwap } from "../lib/quote";
import { rawPriceFromMarketPrice, QuoteValidationError } from "../lib/quote/calc";
import { getAvailQuote } from "../lib/quote/apiClient";
import type { Quote } from "../lib/quote/types";
import { routeFor } from "../config/kalqix";
import { getToken, type TokenSymbol } from "../config/tokens";
import { useActivityLog } from "../store/activityLog";
import { useActiveNetwork } from "./useActiveNetwork";

const QUOTE_REFRESH_MS = 5_000;

export function useMarket(ticker: string, enabled = true) {
  const log = useActivityLog((s) => s.push);
  const network = useActiveNetwork();
  return useQuery({
    queryKey: ["market", network.key, ticker],
    enabled,
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
  const useApi = !!network.useQuoteApi;
  const route = useMemo(
    () => routeFor(network, tokenIn, tokenOut),
    [network, tokenIn, tokenOut]
  );
  // Market metadata is only needed for the local quoteSwap path.
  const market = useMarket(
    route?.ticker ?? network.kalqixMarketTickers.cbBTC,
    !useApi
  );
  const log = useActivityLog((s) => s.push);

  const query = useQuery({
    queryKey: [
      "quote",
      network.key,
      useApi,
      route?.ticker,
      route?.side,
      tokenIn,
      tokenOut,
      amountIn.toString(),
      slippageBps,
    ],
    enabled:
      enabled && !!route && amountIn > 0n && (useApi || !!market.data),
    refetchInterval: (q) =>
      q.state.error instanceof QuoteValidationError ? false : QUOTE_REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: (_n, err) => !(err instanceof QuoteValidationError),
    queryFn: async (): Promise<Quote> => {
      if (!route) throw new Error("Missing route");
      const inInfo = getToken(network, tokenIn);
      const outInfo = getToken(network, tokenOut);

      // ---- Avail /quote API path (service owns the math) ----
      if (useApi) {
        const t0 = performance.now();
        const resp = await getAvailQuote(network.availEscrowBaseUrl, {
          tokenIn: inInfo.address,
          tokenOut: outInfo.address,
          amountIn,
          slippageBps,
        });
        log({
          level: "info",
          channel: "API",
          message: `POST /quote ${tokenIn}→${tokenOut} · ${resp.error_code ?? "200"}`,
          details: `${Math.round(performance.now() - t0)}ms`,
        });
        if (resp.error_code) {
          throw new Error(resp.error_message || resp.error_code);
        }
        const v = resp.quotes?.[0];
        if (!v) throw new QuoteValidationError("No route available for this pair.");
        if (v.error_code) throw new Error(v.error_message || v.error_code);
        if (!v.amount_out || v.amount_out === "0") {
          throw new QuoteValidationError("Amount is too small for this market.");
        }
        const amountOut = BigInt(v.amount_out);
        const amountOutMin =
          v.amount_out_min && v.amount_out_min !== "0"
            ? BigInt(v.amount_out_min)
            : (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
        // Derive a display price (USDC per base) from the amounts — /quote
        // returns no price field. USDC is always the quote leg.
        const usdcAmt = tokenIn === "USDC" ? amountIn : amountOut;
        const baseAmt = tokenIn === "USDC" ? amountOut : amountIn;
        const baseDecimals =
          tokenIn === "USDC" ? outInfo.decimals : inInfo.decimals;
        const baseHuman = Number(baseAmt) / 10 ** baseDecimals;
        const priceHuman =
          baseHuman > 0 ? Number(usdcAmt) / 1e6 / baseHuman : 0;
        return {
          amountIn,
          amountInDecimals: inInfo.decimals,
          amountOut,
          amountOutMin,
          amountOutDecimals: outInfo.decimals,
          priceHuman,
          takerFeeBps: null, // /quote bakes fees into amount_out; no breakdown
          slippageBps,
          side: route.side,
          ticker: route.ticker,
          fetchedAt: resp.quoted_at || Date.now(),
        };
      }

      // ---- Local path: KalqiX price + quoteSwap ----
      if (!market.data) throw new Error("Missing market");
      const t0 = performance.now();
      const price = await getMarketPrice(
        network.kalqixBaseUrl,
        route.ticker,
        route.side
      );
      log({
        level: "info",
        channel: "API",
        message: `GET /markets/${route.ticker}/market-price?side=${route.side} · 200`,
        details: `${Math.round(performance.now() - t0)}ms`,
      });
      const rawPrice = rawPriceFromMarketPrice(price);
      return quoteSwap({
        tokenIn: inInfo,
        tokenOut: outInfo,
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
