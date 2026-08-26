import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import { getMarket, getMarketPrice, quoteSwap } from "../lib/quote";
import { rawPriceFromMarketPrice, QuoteValidationError } from "../lib/quote/calc";
import {
  getAvailQuoteV2,
  BadChainIdError,
  type AvailQuoteVenueV2,
} from "../lib/quote/apiClient";
import type { MultiQuote, VenueFailure, VenueQuote } from "../lib/quote/types";
import { disallowedExchanges } from "../lib/quote/kyberSources";
import { kalqixSymbolFor, routeForAddresses } from "../config/kalqix";
import { getToken } from "../config/tokens";
import type { ChainToken } from "../lib/tokens";
import type { Venue } from "../config/deployments";
import { useActivityLog } from "../store/activityLog";
import { useActiveChain, useActiveDeployment } from "./useSession";

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
  "BAD_VENUES",
  "BAD_VENUE_OPTIONS",
  "BAD_CHAIN_ID",
]);

export function useMarket(ticker: string, enabled = true) {
  const log = useActivityLog((s) => s.push);
  const network = useActiveDeployment();
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
  tokenIn: ChainToken | null;
  tokenOut: ChainToken | null;
  amountIn: bigint;
  slippageBps: number;
  /** Venues to quote (already filtered for supported-token limits by the
   *  caller). Ignored on the legacy local path. Defaults to the deployment's
   *  configured venues. */
  venues?: Venue[];
  /** Restrict KYBERSWAP routing to this chain's QuickSwap pools, to reproduce
   *  what a QuickSwap user would be quoted and execute against. Ignored on
   *  chains with no `quickswapSources`. */
  quickswapOnly?: boolean;
  enabled?: boolean;
  /** Poll cadence. The open-routing benchmark runs slower than the primary
   *  quote — it's a reference number, not the one being executed. */
  refreshMs?: number;
  /** Venues that should return executable calldata with the quote. The caller
   *  owns this policy because it depends on state this hook can't see: KALQIX
   *  is excluded while the permit flow is active (the permit is baked into
   *  deposit calldata at quote time, so it cannot precede its own signature).
   *  Empty/omitted → quote-only, and calldata is fetched at confirm instead. */
  calldataFor?: Venue[];
  /** Connected wallet. REQUIRED by the API for KYBERSWAP calldata, so Kyber
   *  pre-fetch is unavailable until a wallet is connected. */
  userWallet?: Address;
}

export function useQuote({
  tokenIn,
  tokenOut,
  amountIn,
  slippageBps,
  venues,
  quickswapOnly = false,
  enabled = true,
  refreshMs = QUOTE_REFRESH_MS,
  calldataFor,
  userWallet,
}: QuoteArgs) {
  const network = useActiveDeployment();
  const chain = useActiveChain();
  // venues present on the deployment → multi-venue /v2 API path; absent →
  // legacy local KalqiX quoting (mainnet).
  const v2 = !!network.venues;
  const allowedVenues = useMemo(
    () => venues ?? network.venues ?? [],
    [venues, network.venues]
  );
  /**
   * Venues that get `create_calldata`, intersected with the venues we're
   * actually asking for.
   *
   * The server rejects the mismatch outright: requesting kalqix.create_calldata
   * without KALQIX in `venues` fails the WHOLE request with BAD_VENUES
   * ("kalqix.create_intent requires KALQIX in venues"), losing the other
   * venue's quote too. The two lists are computed independently upstream —
   * venue gating from supported-token limits, calldata policy from permit and
   * wallet state — so they can disagree both transiently (mid deployment
   * switch) and persistently (a venue gated out by an amount limit).
   */
  const calldataVenues = useMemo(
    () => (calldataFor ?? []).filter((v) => allowedVenues.includes(v)),
    [calldataFor, allowedVenues]
  );
  // Only testnet differs — its backend rejects 84532 and registers its Base
  // Sepolia assets under 8453. Everywhere else this is just chain.id.
  const quoteChainId = network.quoteChainId ?? chain.id;
  // A KalqiX market only exists for USDC-quoted pairs of KalqiX assets, which
  // is Base-only. Everything else quotes through KYBERSWAP with no route.
  const route = useMemo(
    () =>
      tokenIn && tokenOut && chain.kalqixEnabled
        ? routeForAddresses(network, tokenIn.address, tokenOut.address)
        : null,
    [network, chain.kalqixEnabled, tokenIn, tokenOut]
  );
  // Market metadata is only needed for the local quoteSwap path.
  const market = useMarket(
    route?.ticker ?? network.kalqixMarketTickers.cbBTC,
    !v2 && !!route
  );
  const log = useActivityLog((s) => s.push);

  const query = useQuery({
    queryKey: [
      "quote",
      network.key,
      chain.id,
      v2,
      allowedVenues.join(","),
      tokenIn?.address,
      tokenOut?.address,
      amountIn.toString(),
      slippageBps,
      quickswapOnly,
      calldataVenues.join(","),
      userWallet ?? "",
    ],
    enabled:
      enabled &&
      !!tokenIn &&
      !!tokenOut &&
      amountIn > 0n &&
      // The legacy path can only quote a KalqiX market; v2 quotes any pair.
      (v2 ? allowedVenues.length > 0 : !!route && !!market.data),
    refetchInterval: (q) =>
      q.state.error instanceof QuoteValidationError ? false : refreshMs,
    refetchIntervalInBackground: false,
    retry: (_n, err) =>
      !(err instanceof QuoteValidationError) && !(err instanceof BadChainIdError),
    queryFn: async (): Promise<MultiQuote> => {
      if (!tokenIn || !tokenOut) throw new Error("Missing token selection");

      // ---- Avail /v2/quote path (multi-venue, service owns the math) ----
      if (v2) {
        // QuickSwap-only mode asks the orchestrator to restrict Kyber's route
        // discovery via kyberswap.route_options. KALQIX is unaffected.
        const restrictTo =
          quickswapOnly && allowedVenues.includes("KYBERSWAP")
            ? chain.quickswapSources
            : undefined;

        const t0 = performance.now();
        const resp = await getAvailQuoteV2(network.availEscrowBaseUrl, {
          chainId: quoteChainId,
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          amountIn,
          slippageBps,
          venues: allowedVenues,
          includedSources: restrictTo?.length ? restrictTo : undefined,
          kalqixCalldata: calldataVenues.includes("KALQIX") ? {} : null,
          // user_wallet is required by the API, so no wallet means no Kyber
          // calldata — the quote still succeeds, and confirm falls back to the
          // payload form of POST /intent.
          kyberCalldata:
            calldataVenues.includes("KYBERSWAP") && userWallet
              ? { userWallet }
              : null,
        });
        log({
          level: "info",
          channel: "API",
          message: `POST /v2/quote ${tokenIn.symbol}→${tokenOut.symbol} · ${resp.error_code ?? "200"}`,
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
        // No client-side venue filter: `venues` binds server-side on POST, so
        // the response only contains venues we asked for.
        for (const v of resp.quotes ?? []) {
          const parsed = parseVenueQuote(v, {
            quoteId: resp.quote_id,
            userAmountIn: amountIn,
            slippageBps,
            inDecimals: tokenIn.decimals,
            outDecimals: tokenOut.decimals,
            // Price is quoted per base asset only on a KalqiX market; for an
            // arbitrary Kyber pair it's simply output-per-input.
            quoteLegIsIn:
              !!route && kalqixSymbolFor(network, tokenIn.address) === "USDC",
            side: route?.side ?? "BUY",
            ticker: route?.ticker ?? `${tokenIn.symbol}_${tokenOut.symbol}`,
          });
          if ("failure" in parsed) {
            // "route not found" while restricted almost always means the pair
            // has no QuickSwap pool at all, not that the venue is down —
            // long-tail tokens routinely trade only on Aerodrome/Uniswap/etc.
            // Say so, and point at the toggle that fixes it. (This is the same
            // dead end QuickSwap's own UI hits before offering its V4
            // fallback.)
            if (
              restrictTo?.length &&
              parsed.failure.venue === "KYBERSWAP" &&
              /route not found/i.test(parsed.failure.message ?? "")
            ) {
              failures.push({
                ...parsed.failure,
                message: `No QuickSwap pool for this pair on ${chain.label} — turn off QuickSwap-only routing to quote it.`,
              });
              continue;
            }
            failures.push(parsed.failure);
            continue;
          }
          // Trust the route, not the request: if we asked for restricted
          // sources, the returned hops must actually be those sources. A
          // dropped route_options would otherwise surface as a normal
          // best-route quote wearing a "QuickSwap only" label.
          if (restrictTo?.length && parsed.quote.venue === "KYBERSWAP") {
            const foreign = disallowedExchanges(
              parsed.quote.executionContext,
              restrictTo
            );
            if (foreign.length > 0) {
              log({
                level: "warn",
                channel: "QUOTE",
                message: `route_options ignored — route used ${foreign.join(", ")}`,
              });
              failures.push({
                venue: "KYBERSWAP",
                code: "SOURCES_NOT_APPLIED",
                message: `Route used ${foreign.join(", ")} — venue not restricted to QuickSwap.`,
              });
              continue;
            }
          }
          quotes.push(parsed.quote);
        }
        if (quotes.length === 0 && failures.length === 0) {
          // A 200 with an empty `quotes` array is how the API reports an
          // unsatisfiable chain+venue combination (e.g. KALQIX on Arbitrum).
          throw new QuoteValidationError(
            `No venue serves this pair on ${chain.label}.`
          );
        }
        // Best-first. The server already sorts, but a substituted
        // QuickSwap-only quote lands out of order, so re-sort regardless.
        quotes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));
        // Failures render per-venue — an all-failed response is still data,
        // not an exception.
        return { quoteId: resp.quote_id, quotes, failures };
      }

      // ---- Legacy local path: KalqiX price + quoteSwap (mainnet) ----
      if (!route) throw new Error("Pair is not a KalqiX market");
      if (!market.data) throw new Error("Missing market");
      const symIn = kalqixSymbolFor(network, tokenIn.address);
      const symOut = kalqixSymbolFor(network, tokenOut.address);
      if (!symIn || !symOut) throw new Error("Pair is not a KalqiX market");
      const inInfo = getToken(network, symIn);
      const outInfo = getToken(network, symOut);
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
            quoteId: null,
            approvalAddress: network.escrowContract,
            executionContext: null,
            routeSummaryJson: null,
            // The legacy backend has no calldata-on-quote; this path always
            // fetches calldata from the payload form of POST /intent.
            calldata: null,
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
  /** Response-level `quote_id`, bound onto each quote so confirm never pairs an
   *  id with calldata from a different poll. */
  quoteId: string;
  userAmountIn: bigint;
  slippageBps: number;
  inDecimals: number;
  outDecimals: number;
  /** True when the input token is the market's quote leg (USDC on a KalqiX
   *  market). Drives which way round the displayed price reads. */
  quoteLegIsIn: boolean;
  side: "BUY" | "SELL";
  ticker: string;
}

function parseVenueQuote(
  v: AvailQuoteVenueV2,
  ctx: ParseCtx
): { quote: VenueQuote } | { failure: VenueFailure } {
  // Success and failure share the `details` slot; error_code discriminates.
  const d = v.details ?? {};
  const fail = (code: string, message: string | null): { failure: VenueFailure } => ({
    failure: { venue: v.venue, code, message },
  });
  if (d.error_code) {
    // KYBERSWAP failures often carry the useful message in kyber_message
    // (error_message is empty-string on the live backend).
    return fail(d.error_code, d.error_message || d.kyber_message || null);
  }
  if (!v.amount_out || v.amount_out === "0") {
    return fail("NO_QUOTE", "Amount is too small for this market.");
  }
  if (!d.approval_address) {
    return fail("NO_APPROVAL_ADDRESS", "Venue returned no approval address.");
  }

  // KALQIX returns a KalqiX-aligned input amount that can differ from the
  // requested one — permits, msg.value and the intent body must all use it.
  const amountIn =
    v.venue === "KALQIX" && d.amount_in
      ? BigInt(d.amount_in)
      : ctx.userAmountIn;
  const amountOut = BigInt(v.amount_out);
  const amountOutMin =
    d.amount_out_min && d.amount_out_min !== "0"
      ? BigInt(d.amount_out_min)
      : (amountOut * BigInt(10_000 - ctx.slippageBps)) / 10_000n;

  // Display price, derived from the amounts (the API returns no price field)
  // using each token's own decimals. On a KalqiX market with USDC in, that
  // reads as quote-per-base; otherwise it's plainly output-per-input.
  const inHuman = Number(amountIn) / 10 ** ctx.inDecimals;
  const outHuman = Number(amountOut) / 10 ** ctx.outDecimals;
  const priceHuman = ctx.quoteLegIsIn
    ? outHuman > 0
      ? inHuman / outHuman
      : 0
    : inHuman > 0
      ? outHuman / inHuman
      : 0;

  const executionContext = d.execution_context ?? null;

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
      fetchedAt: Math.min(v.quoted_at_ms ?? Date.now(), Date.now()),
      venue: v.venue as Venue,
      quoteId: ctx.quoteId,
      approvalAddress: d.approval_address,
      // Same parsed reference — the verbatim-routeSummary guarantee.
      executionContext,
      routeSummaryJson:
        executionContext?.routeSummary !== undefined
          ? JSON.stringify(executionContext.routeSummary)
          : null,
      // Present only when this venue was in `calldataFor`.
      calldata: d.calldata ?? null,
    },
  };
}
