import { parseUnits } from "viem";
import type { KalqiXMarket, KalqiXMarketPrice, Quote, Side } from "./types";
import type { TokenInfo } from "../../config/tokens";

const BPS_DENOM = 10_000n;

/**
 * A quote could not be produced because the user's input doesn't satisfy a
 * deterministic market constraint (step size, minimum quantity, minimum trade
 * size). Re-fetching the price won't fix it — only changing the input will.
 *
 * Callers (e.g. useQuote) detect this class to stop polling.
 */
export class QuoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteValidationError";
  }
}

/**
 * KalqiX returns `step_size` and `tick_size` as decimal strings in **human
 * units** (e.g. "0.0001" BTC, "0.01" USDC/BTC). Convert to base units.
 *
 * `min_quantity`, `min_trade_size`, `min_price`, and `price` are returned as
 * integer strings already in **base units** — those parse straight to BigInt.
 */
export function stepSizeBaseUnits(market: KalqiXMarket): bigint {
  // Constrains the *base-asset* quantity side of an order.
  return parseUnits(market.step_size, market.base_asset_decimals);
}

export function tickSizeBaseUnits(market: KalqiXMarket): bigint {
  // tick_size is a decimal price increment (quote-per-1-base, in human units).
  // The on-chain rule is: the quote-asset side of an order must be a multiple
  // of (tick_size scaled to quote-asset base units).
  return parseUnits(market.tick_size, market.quote_asset_decimals);
}

/**
 * Convert a KalqiX `taker_fee` string ("0.2" → 20 bps) to integer basis points.
 * Throws on malformed input — KalqiX returns this as a decimal-string percentage.
 */
export function takerFeeBps(market: KalqiXMarket): number {
  const pct = Number(market.taker_fee);
  if (!Number.isFinite(pct) || pct < 0) {
    throw new Error(`Invalid taker_fee from KalqiX: ${market.taker_fee}`);
  }
  return Math.round(pct * 100); // 0.2% → 20 bps
}

/**
 * KalqiX returns prices in base units of the quote asset per base asset.
 * Example for BTC/USDC: price "67251420000" → 67251.42 USDC per 1 BTC.
 *   - quote_asset_decimals = 6
 *   - so the human price is rawPrice / 10^quote_decimals.
 *
 * We keep the raw integer so all swap math stays in BigInt — see quoteSwap below.
 */
export function rawPriceFromMarketPrice(p: KalqiXMarketPrice): bigint {
  if (!p.price) throw new Error("KalqiX market-price missing `price` field");
  // The API may return an integer-string (base units) or a decimal-string.
  // Be defensive: parse whichever it gave us.
  if (p.price.includes(".")) {
    // Shouldn't happen per spec, but if it does we have no decimals here —
    // surface clearly rather than silently rounding.
    throw new Error(
      `Unexpected decimal price from KalqiX: ${p.price}. Expected base-unit integer.`
    );
  }
  return BigInt(p.price);
}

interface QuoteInput {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: bigint;
  side: Side;
  ticker: string;
  market: KalqiXMarket;
  rawPrice: bigint;
  slippageBps: number;
  fetchedAt: number;
}

/** Floor `amount` to the nearest multiple of `step` (both in the same base units). */
function floorToStep(amount: bigint, step: bigint): bigint {
  if (step <= 1n) return amount;
  return (amount / step) * step;
}

/** Ceil `amount` to the nearest multiple of `step`. Useful for "smallest step-aligned value ≥ X". */
function ceilToStep(amount: bigint, step: bigint): bigint {
  if (step <= 1n) return amount;
  return ((amount + step - 1n) / step) * step;
}

/**
 * Compute amountOut given a single-level KalqiX price.
 *
 * Math (BUY: pay quote, receive base):
 *   amountOutBase = amountInQuote * 10^baseDec / rawPrice
 *
 * Math (SELL: pay base, receive quote):
 *   amountOutQuote = amountInBase * rawPrice / 10^baseDec
 *
 * KalqiX enforces two constraints on the **base-asset quantity** at order time:
 *   - `step_size` — quantity must be a multiple of this
 *   - `min_quantity` — quantity must be ≥ this
 *
 * For BUY the base-asset quantity is `amount_out` (rounded down to step).
 * For SELL the base-asset quantity is `amount_in` (rounded down to step).
 * Rounding **down** keeps every calculation conservative — the contract's slippage
 * check `received >= amount_out` is never violated by our own math.
 *
 * All BigInt — no floats touch the swap path.
 */
export function quoteSwap(input: QuoteInput): Quote {
  const {
    tokenIn,
    tokenOut,
    amountIn,
    side,
    ticker,
    market,
    rawPrice,
    slippageBps,
    fetchedAt,
  } = input;

  if (amountIn <= 0n) {
    throw new Error("amountIn must be > 0");
  }
  if (rawPrice <= 0n) {
    throw new Error("rawPrice must be > 0");
  }

  const baseScale = 10n ** BigInt(market.base_asset_decimals);
  const stepSize = stepSizeBaseUnits(market);
  const tickSize = tickSizeBaseUnits(market);
  const minQuantity = BigInt(market.min_quantity);
  const minTradeSize = BigInt(market.min_trade_size);

  // ---------- 1. derive effective input + gross output ----------
  // The BASE-asset side aligns to step_size (a real KalqiX quantity
  // constraint). The QUOTE-asset side is NOT tick-aligned: tick_size is a price
  // increment, not a notional constraint. BUY still floors its quote-asset
  // *input* to the tick as a conservative spend cap (never spends more than
  // entered); the SELL *output* keeps full quote precision (see step 3).
  let effectiveAmountIn = amountIn;
  let amountOutGross: bigint;

  if (side === "BUY") {
    // amount_in is quote → align to tick.
    effectiveAmountIn = floorToStep(amountIn, tickSize);
    if (effectiveAmountIn < minTradeSize) {
      throw new QuoteValidationError(
        `Below market minimum trade size: ${formatBaseUnits(minTradeSize, market.quote_asset_decimals)} ${market.quote_asset} required.`
      );
    }
    amountOutGross = (effectiveAmountIn * baseScale) / rawPrice;
  } else {
    // amount_in is base → align to step.
    effectiveAmountIn = floorToStep(amountIn, stepSize);
    if (effectiveAmountIn === 0n || effectiveAmountIn < minQuantity) {
      // KalqiX's min_quantity isn't necessarily a multiple of step_size, so the
      // real practical floor is the smallest step-aligned value ≥ min_quantity.
      const practicalMin = ceilToStep(minQuantity, stepSize);
      throw new QuoteValidationError(
        `Below market minimum: try at least ${formatBaseUnits(practicalMin, market.base_asset_decimals)} ${market.base_asset} (KalqiX requires ≥ ${formatBaseUnits(minQuantity, market.base_asset_decimals)} ${market.base_asset} on a ${formatBaseUnits(stepSize, market.base_asset_decimals)} step).`
      );
    }
    amountOutGross = (effectiveAmountIn * rawPrice) / baseScale;
    if (amountOutGross < minTradeSize) {
      throw new QuoteValidationError(
        `Below market minimum trade size: ${formatBaseUnits(minTradeSize, market.quote_asset_decimals)} ${market.quote_asset} notional required.`
      );
    }
  }

  // ---------- 2. fees + slippage ----------
  const feeBps = BigInt(takerFeeBps(market));
  let amountOut = (amountOutGross * (BPS_DENOM - feeBps)) / BPS_DENOM;
  let amountOutMin = (amountOut * (BPS_DENOM - BigInt(slippageBps))) / BPS_DENOM;

  // ---------- 3. align / validate the OUTPUT side ----------
  if (side === "BUY") {
    // amount_out is base → step grid.
    amountOut = floorToStep(amountOut, stepSize);
    amountOutMin = floorToStep(amountOutMin, stepSize);
    if (amountOutMin < minQuantity) {
      // Estimate the user-facing input amount that *would* clear min_quantity,
      // accounting for fee + slippage + a single step of safety margin.
      const safeQty = minQuantity + stepSize;
      const neededIn =
        (((safeQty * rawPrice) / baseScale) * BPS_DENOM * BPS_DENOM) /
        ((BPS_DENOM - feeBps) * (BPS_DENOM - BigInt(slippageBps)));
      throw new QuoteValidationError(
        `Below market minimum: try at least ${formatBaseUnits(neededIn, market.quote_asset_decimals)} ${market.quote_asset} (KalqiX requires ≥ ${formatBaseUnits(minQuantity, market.base_asset_decimals)} ${market.base_asset}).`
      );
    }
  } else {
    // amount_out is the quote asset. tick_size is a *price* increment, not a
    // constraint on the output notional — settlement delivers price × quantity
    // at full quote-asset precision (e.g. 12.298736 USDC), and Avail's /intent
    // API accepts non-tick-aligned amounts (verified). So we keep full 6-dp
    // precision here instead of flooring to the tick; the BigInt division above
    // already floors to base units, which stays conservative for the on-chain
    // `received >= amountOutMin` check. Only the min-trade-size floor applies.
    if (amountOutMin < minTradeSize) {
      throw new QuoteValidationError(
        `Below market minimum trade size: ${formatBaseUnits(minTradeSize, market.quote_asset_decimals)} ${market.quote_asset} notional required after fees + slippage.`
      );
    }
  }

  const priceHuman =
    Number(rawPrice) / 10 ** market.quote_asset_decimals;

  return {
    amountIn: effectiveAmountIn,
    amountInDecimals: tokenIn.decimals,
    amountOut,
    amountOutMin,
    amountOutDecimals: tokenOut.decimals,
    priceHuman,
    takerFeeBps: Number(feeBps),
    slippageBps,
    side,
    ticker,
    fetchedAt,
  };
}

function formatBaseUnits(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const frac = amount % scale;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}
