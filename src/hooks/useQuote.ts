import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getMarket, getMarketPrice, quoteSwap } from "../lib/quote";
import { rawPriceFromMarketPrice, QuoteValidationError } from "../lib/quote/calc";
import {
  getAvailQuoteV2,
  type AvailQuoteVenueV2,
} from "../lib/quote/apiClient";
import type { MultiQuote, VenueFailure, VenueQuote } from "../lib/quote/types";
import { routeFor } from "../config/kalqix";
import { getToken, type TokenSymbol } from "../config/tokens";
import type { Venue } from "../config/networks";
import { useActivityLog } from "../store/activityLog";
import { useActiveNetwork } from "./useActiveNetwork";

const QUOTE_REFRESH_MS = 5_000;

/** Request-level /v2/quote error codes that mean "change the input", not
 *  "retry" — mapped to QuoteValidationError so polling/retry stop. */
const VALIDATION_ERROR_CODES = new Set([
  "BAD_TOKEN_IN",
  "BAD_TOKEN_OUT",
  "TOKEN_IN_NOT_SUPPORTED",
  "TOKEN_OUT_NOT_SUPPORTED",
  "NO_MARKET_FOUND",
  "BAD_SLIPPAGE",
  "BAD_WHITELISTED_VENUES",
]);

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
  /** Venues to quote (already filtered for supported-token limits by the
   *  caller). Ignored on the legacy local path. Defaults to the network's
   *  configured venues. */
  venues?: Venue[];
  enabled?: boolean;
}

export function useQuote({
  tokenIn,
  tokenOut,
  amountIn,
  slippageBps,
  venues,
  enabled = true,
}: QuoteArgs) {
  const network = useActiveNetwork();
  // venues present on the network → multi-venue /v2 API path; absent →
  // legacy local KalqiX quoting (mainnet).
  const v2 = !!network.venues;
  const allowedVenues = useMemo(
    () => venues ?? network.venues ?? [],
    [venues, network.venues]
  );
  const route = useMemo(
    () => routeFor(network, tokenIn, tokenOut),
    [network, tokenIn, tokenOut]
  );
  // Market metadata is only needed for the local quoteSwap path.
  const market = useMarket(
    route?.ticker ?? network.kalqixMarketTickers.cbBTC,
    !v2
  );
  const log = useActivityLog((s) => s.push);

  const query = useQuery({
    queryKey: [
      "quote",
      network.key,
      v2,
      allowedVenues.join(","),
      route?.ticker,
      route?.side,
      tokenIn,
      tokenOut,
      amountIn.toString(),
      slippageBps,
    ],
    enabled:
      enabled &&
      !!route &&
      amountIn > 0n &&
      (v2 ? allowedVenues.length > 0 : !!market.data),
    refetchInterval: (q) =>
      q.state.error instanceof QuoteValidationError ? false : QUOTE_REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: (_n, err) => !(err instanceof QuoteValidationError),
    queryFn: async (): Promise<MultiQuote> => {
      if (!route) throw new Error("Missing route");
      const inInfo = getToken(network, tokenIn);
      const outInfo = getToken(network, tokenOut);

      // ---- Avail /v2/quote path (multi-venue, service owns the math) ----
      if (v2) {
        const t0 = performance.now();
        const resp = await getAvailQuoteV2(network.availEscrowBaseUrl, {
          tokenIn: inInfo.address,
          tokenOut: outInfo.address,
          amountIn,
          slippageBps,
          whitelistedVenues: allowedVenues,
        });
        log({
          level: "info",
          channel: "API",
          message: `GET /v2/quote ${tokenIn}→${tokenOut} · ${resp.error_code ?? "200"}`,
          details: `${Math.round(performance.now() - t0)}ms`,
        });
        if (resp.error_code) {
          const msg = resp.error_message || resp.error_code;
          if (VALIDATION_ERROR_CODES.has(resp.error_code)) {
            throw new QuoteValidationError(msg);
          }
          throw new Error(msg);
        }

        const quotes: VenueQuote[] = [];
        const failures: VenueFailure[] = [];
        // Belt-and-braces: the whitelist param is sent, but the live backend
        // doesn't filter on it yet (see getAvailQuoteV2) — restrict to this
        // env's enabled venues here regardless.
        const allowed = new Set<string>(allowedVenues);
        for (const v of resp.quotes ?? []) {
          if (!allowed.has(v.venue_name)) continue;
          const parsed = parseVenueQuote(v, {
            userAmountIn: amountIn,
            slippageBps,
            tokenIn,
            inDecimals: inInfo.decimals,
            outDecimals: outInfo.decimals,
            side: route.side,
            ticker: route.ticker,
          });
          if ("failure" in parsed) failures.push(parsed.failure);
          else quotes.push(parsed.quote);
        }
        if (quotes.length === 0 && failures.length === 0) {
          throw new QuoteValidationError("No route available for this pair.");
        }
        // Server order is best-first; keep it. Failures render per-venue —
        // an all-failed response is still data, not an exception.
        return { quoteId: resp.id, quotes, failures };
      }

      // ---- Legacy local path: KalqiX price + quoteSwap (mainnet) ----
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
      const local = quoteSwap({
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
      return {
        quoteId: null,
        quotes: [
          {
            ...local,
            venue: "KALQIX",
            approvalAddress: network.escrowContract,
            venueDetail: null,
            routeSummaryJson: null,
          },
        ],
        failures: [],
      };
    },
  });

  return {
    ...query,
    market,
    route,
  };
}

interface ParseCtx {
  userAmountIn: bigint;
  slippageBps: number;
  tokenIn: TokenSymbol;
  inDecimals: number;
  outDecimals: number;
  side: "BUY" | "SELL";
  ticker: string;
}

function parseVenueQuote(
  v: AvailQuoteVenueV2,
  ctx: ParseCtx
): { quote: VenueQuote } | { failure: VenueFailure } {
  const fail = (code: string, message: string | null): { failure: VenueFailure } => ({
    failure: { venue: v.venue_name, code, message },
  });
  if (v.error_code) {
    // KYBERSWAP failures often carry the useful message in kyber_error_message
    // (error_message is empty-string on the live backend).
    return fail(
      v.error_code,
      v.error_message || v.kyber_error_message || null
    );
  }
  if (!v.amount_out || v.amount_out === "0") {
    return fail("NO_QUOTE", "Amount is too small for this market.");
  }
  if (!v.approval_address) {
    return fail("NO_APPROVAL_ADDRESS", "Venue returned no approval address.");
  }

  // KALQIX returns a KalqiX-aligned input amount that can differ from the
  // requested one — permits, msg.value and the intent body must all use it.
  const amountIn =
    v.venue_name === "KALQIX" && v.amount_in
      ? BigInt(v.amount_in)
      : ctx.userAmountIn;
  const amountOut = BigInt(v.amount_out);
  const amountOutMin =
    v.amount_out_min && v.amount_out_min !== "0"
      ? BigInt(v.amount_out_min)
      : (amountOut * BigInt(10_000 - ctx.slippageBps)) / 10_000n;

  // Derive a display price (USDC per base) from the amounts — the API
  // returns no price field. USDC is always the quote leg.
  const usdcAmt = ctx.tokenIn === "USDC" ? amountIn : amountOut;
  const baseAmt = ctx.tokenIn === "USDC" ? amountOut : amountIn;
  const baseDecimals =
    ctx.tokenIn === "USDC" ? ctx.outDecimals : ctx.inDecimals;
  const baseHuman = Number(baseAmt) / 10 ** baseDecimals;
  const priceHuman = baseHuman > 0 ? Number(usdcAmt) / 1e6 / baseHuman : 0;

  return {
    quote: {
      amountIn,
      amountInDecimals: ctx.inDecimals,
      amountOut,
      amountOutMin,
      amountOutDecimals: ctx.outDecimals,
      priceHuman,
      takerFeeBps: null, // fees are baked into amount_out; no breakdown
      slippageBps: ctx.slippageBps,
      side: ctx.side,
      ticker: ctx.ticker,
      // Clamp so a server clock ahead of the client can't extend the TTL.
      fetchedAt: Math.min(v.quoted_at ?? Date.now(), Date.now()),
      venue: v.venue_name as Venue,
      approvalAddress: v.approval_address,
      // Same parsed reference — the verbatim-routeSummary guarantee.
      venueDetail: v.venue_detail ?? null,
      routeSummaryJson:
        v.venue_detail?.routeSummary !== undefined
          ? JSON.stringify(v.venue_detail.routeSummary)
          : null,
    },
  };
}
