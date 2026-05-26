//! The two order-placement strategies under comparison.
//!
//! Both differ ONLY on BUY-side order construction. On SELL the `amount_in`
//! is already base-asset and step-aligned, so the order is identical between
//! algos and no underspend is possible.
//!
//! Algo A mirrors the production solver's pricing: implied rate from
//! amount_in/amount_out, capped at market_price ± max_price_deviation_percent,
//! tick-aligned. This is the reference behaviour we're comparing against.

use crate::error::AppError;
use crate::kalqix::{
    KalqiXClient, KalqiXMarket, KalqiXSide, NewOrderBody, OrderType, TIF_FOK,
};
use crate::state::Side;
use alloy::primitives::U256;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Algo {
    /// Mirrors the current Avail production solver behaviour: LIMIT order
    /// sized to just clear `amount_out_min`, priced at the implied rate
    /// (amount_in / amount_out) capped at market_price ± max_deviation%,
    /// tick-aligned, FOK. Underspends on BUY because the order quantity is
    /// the minimum that clears the floor, not the maximum the budget allows.
    ClearMin,
    /// MARKET BUY with `quote_quantity = amount_in`, FOK. Delegates the
    /// book-walking to KalqiX. **In practice expires on KalqiX** — keeping
    /// this in the harness as the "if KalqiX supported this we wouldn't
    /// need Algo C" baseline.
    MaximizeFill,
    /// LIMIT BUY sized to consume the full `amount_in` budget, priced at a
    /// small safety buffer above best_ask, FOK. The harness-side maximize-
    /// fill implementation that doesn't depend on KalqiX's MARKET behaviour.
    /// Same SELL behaviour as the other algos (no underspend on that side).
    MaxFillLimit,
}

impl Algo {
    pub fn label(self) -> &'static str {
        match self {
            Algo::ClearMin => "clear_min",
            Algo::MaximizeFill => "maximize_fill",
            Algo::MaxFillLimit => "max_fill_limit",
        }
    }
}

/// Construct the KalqiX order body for the given (algo, side, amounts).
pub async fn build_order(
    client: &KalqiXClient,
    algo: Algo,
    side: Side,
    amount_in: U256,
    amount_out_min: U256,
) -> Result<NewOrderBody, AppError> {
    let ticker = client.market().to_string();

    // Algo B · BUY: MARKET + quote_quantity, no market read needed.
    if matches!((algo, side), (Algo::MaximizeFill, Side::Buy)) {
        return Ok(NewOrderBody {
            ticker,
            side: KalqiXSide::Buy,
            order_type: OrderType::Market,
            time_in_force: TIF_FOK,
            expires_at: 0,
            quantity: None,
            quote_quantity: Some(amount_in.to_string()),
            price: None,
        });
    }

    // Everything else is a LIMIT order. Fetch market params + current price.
    let market = client.get_market().await?;
    let tick_size = parse_tick_size(&market)?;
    let step_size = parse_step_size(&market)?;
    let fee_bps = parse_fee_bps(&market)?;
    let max_deviation_pct = market.max_price_deviation_percent.unwrap_or(10);
    let base_scale = U256::from(10u64).pow(U256::from(market.base_asset_decimals));
    let bps = U256::from(10_000u64);

    let kalqix_side = match side {
        Side::Buy => KalqiXSide::Buy,
        Side::Sell => KalqiXSide::Sell,
    };
    let market_price_resp = client.get_market_price(kalqix_side).await?;
    let market_price = u256_from_decimal(&market_price_resp.price)?;
    if market_price.is_zero() {
        return Err(AppError::Kalqix("market price is zero".into()));
    }

    // Algo C · BUY: maximize fill within budget, as a LIMIT FOK.
    if matches!((algo, side), (Algo::MaxFillLimit, Side::Buy)) {
        // Largest base-asset quantity affordable at the current ask, including
        // the 0.07% taker fee. Step-aligned.
        //   N_max = floor(amount_in × 10^baseDec × BPS / (ask × (BPS + fee_bps)), step)
        let numer = amount_in * base_scale * bps;
        let denom = market_price * (bps + U256::from(fee_bps));
        let n_unaligned = numer / denom;
        let n_max = floor_to_tick(n_unaligned, step_size);
        if n_max < amount_out_min {
            return Err(AppError::Kalqix(format!(
                "max-fill sizing came in below amount_out_min ({} < {}); price moved up since quote",
                n_max, amount_out_min
            )));
        }
        // Limit price set with a 50bps safety buffer above market — covers
        // tick movement between quote and place. Ceil to tick. Capped at
        // market_price + max_deviation% (KalqiX would reject orders above).
        let buffered = market_price + (market_price * U256::from(50u64)) / bps;
        let upper_cap = market_price + (market_price * U256::from(max_deviation_pct)) / U256::from(100u64);
        let raw_limit = if buffered > upper_cap { upper_cap } else { buffered };
        let final_price = ceil_to_tick(raw_limit, tick_size);
        return Ok(NewOrderBody {
            ticker,
            side: KalqiXSide::Buy,
            order_type: OrderType::Limit,
            time_in_force: TIF_FOK,
            expires_at: 0,
            quantity: Some(n_max.to_string()),
            quote_quantity: None,
            price: Some(final_price.to_string()),
        });
    }

    // Algo A (both sides) + Algo B/C SELL: implied-rate LIMIT FOK.
    let quantity = match side {
        Side::Buy => amount_out_min, // clear the floor
        Side::Sell => amount_in,     // step-aligned by frontend
    };
    let implied_price = match side {
        Side::Buy => (amount_in * base_scale) / amount_out_min,
        Side::Sell => (amount_out_min * base_scale) / amount_in,
    };
    let deviation_num = market_price * U256::from(max_deviation_pct) / U256::from(100u64);
    let final_price = match side {
        Side::Buy => {
            let upper = floor_to_tick(market_price + deviation_num, tick_size);
            let capped = if implied_price > upper { upper } else { implied_price };
            ceil_to_tick(capped, tick_size)
        }
        Side::Sell => {
            let lower = ceil_to_tick(
                market_price.saturating_sub(deviation_num),
                tick_size,
            );
            let capped = if implied_price < lower { lower } else { implied_price };
            floor_to_tick(capped, tick_size)
        }
    };
    if final_price.is_zero() {
        return Err(AppError::Kalqix(format!(
            "computed limit price is zero (implied={}, market={}, deviation={}%)",
            implied_price, market_price, max_deviation_pct
        )));
    }

    Ok(NewOrderBody {
        ticker,
        side: kalqix_side,
        order_type: OrderType::Limit,
        time_in_force: TIF_FOK,
        expires_at: 0,
        quantity: Some(quantity.to_string()),
        quote_quantity: None,
        price: Some(final_price.to_string()),
    })
}

// ───────────────────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────────────────

fn u256_from_decimal(s: &str) -> Result<U256, AppError> {
    U256::from_str_radix(s.trim(), 10)
        .map_err(|e| AppError::Kalqix(format!("price not a decimal integer: {} · raw {:?}", e, s)))
}

/// Convert KalqiX's human-units decimal `tick_size` (e.g. `"0.01"`) into
/// quote-asset base units (e.g. 10_000 for 0.01 USDC at 6 decimals).
fn parse_tick_size(market: &KalqiXMarket) -> Result<U256, AppError> {
    parse_decimal_to_base_units(&market.tick_size, market.quote_asset_decimals)
}

/// Convert `step_size` from human cbBTC units to base-asset base units.
fn parse_step_size(market: &KalqiXMarket) -> Result<U256, AppError> {
    parse_decimal_to_base_units(&market.step_size, market.base_asset_decimals)
}

/// Parse KalqiX `taker_fee` string ("0.07" → 7 bps integer).
fn parse_fee_bps(market: &KalqiXMarket) -> Result<u64, AppError> {
    let pct: f64 = market.taker_fee.parse().map_err(|e| {
        AppError::Kalqix(format!("taker_fee parse: {} · raw {:?}", e, market.taker_fee))
    })?;
    if !pct.is_finite() || pct < 0.0 {
        return Err(AppError::Kalqix(format!("taker_fee invalid: {}", pct)));
    }
    Ok((pct * 100.0).round() as u64)
}

fn parse_decimal_to_base_units(s: &str, decimals: u8) -> Result<U256, AppError> {
    let trimmed = s.trim();
    let mut parts = trimmed.splitn(2, '.');
    let whole = parts.next().unwrap_or("0");
    let frac = parts.next().unwrap_or("");
    if frac.len() > decimals as usize {
        return Err(AppError::Kalqix(format!(
            "decimal {:?} has more precision than {} digits",
            s, decimals
        )));
    }
    let mut padded = String::with_capacity(decimals as usize);
    padded.push_str(frac);
    while padded.len() < decimals as usize {
        padded.push('0');
    }
    let combined = format!("{}{}", whole, padded);
    U256::from_str_radix(&combined, 10).map_err(|e| {
        AppError::Kalqix(format!("could not parse decimal {:?} as integer: {}", s, e))
    })
}

fn floor_to_tick(amount: U256, tick: U256) -> U256 {
    if tick.is_zero() {
        return amount;
    }
    (amount / tick) * tick
}

fn ceil_to_tick(amount: U256, tick: U256) -> U256 {
    if tick.is_zero() {
        return amount;
    }
    let one = U256::from(1u64);
    ((amount + tick - one) / tick) * tick
}
