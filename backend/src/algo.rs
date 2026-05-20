//! The two order-placement strategies under comparison.
//!
//! Both algos differ ONLY on BUY-side order construction. On SELL the
//! `amount_in` is already base-asset and step-aligned, so the order is
//! identical between algos and no underspend is possible.

use crate::error::AppError;
use crate::kalqix::{KalqiXClient, KalqiXSide, NewOrderBody, OrderType, TIF_FOK};
use crate::state::Side;
use alloy::primitives::U256;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Algo {
    /// Mirrors the current Avail production solver behaviour: place an order
    /// sized to just clear `amount_out_min`. Underspends on BUY.
    ClearMin,
    /// MARKET BUY with `quote_quantity = amount_in`, letting KalqiX walk its
    /// own book and spend the full budget. The hypothesis being tested.
    MaximizeFill,
}

impl Algo {
    pub fn label(self) -> &'static str {
        match self {
            Algo::ClearMin => "clear_min",
            Algo::MaximizeFill => "maximize_fill",
        }
    }
}

/// Construct the KalqiX order body for the given (algo, side, amounts).
/// Reads current market price for LIMIT-order overshoot; not needed for MARKET.
pub async fn build_order(
    client: &KalqiXClient,
    algo: Algo,
    side: Side,
    amount_in: U256,
    amount_out_min: U256,
) -> Result<NewOrderBody, AppError> {
    let ticker = client.market().to_string();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let expires_at = now_ms + 30_000;

    match (algo, side) {
        // -------- Algo A · BUY: clear min --------
        (Algo::ClearMin, Side::Buy) => {
            // Read best ask, overshoot slightly so the FOK match succeeds even
            // if the book moved a tick between the read and the place. Safety:
            // 50 bps cap. The contract-level slippage check is amount_out_min
            // (already step-aligned by the frontend) so we never deliver less.
            let px = client.get_market_price(KalqiXSide::Buy).await?;
            let best_ask = u256_from_decimal(&px.price)?;
            let limit_price = best_ask + (best_ask * U256::from(50u64)) / U256::from(10000u64);
            Ok(NewOrderBody {
                ticker,
                side: KalqiXSide::Buy,
                order_type: OrderType::Limit,
                time_in_force: TIF_FOK,
                expires_at,
                quantity: Some(amount_out_min.to_string()),
                quote_quantity: None,
                price: Some(limit_price.to_string()),
            })
        }
        // -------- Algo A · SELL: same as Algo B SELL (no underspend possible) --------
        (Algo::ClearMin, Side::Sell) | (Algo::MaximizeFill, Side::Sell) => {
            // amount_in is base-asset and step-aligned by the frontend. Place
            // a LIMIT SELL at slight undershoot to ensure FOK match against
            // the best bid.
            let px = client.get_market_price(KalqiXSide::Sell).await?;
            let best_bid = u256_from_decimal(&px.price)?;
            let limit_price = best_bid - (best_bid * U256::from(50u64)) / U256::from(10000u64);
            Ok(NewOrderBody {
                ticker,
                side: KalqiXSide::Sell,
                order_type: OrderType::Limit,
                time_in_force: TIF_FOK,
                expires_at,
                quantity: Some(amount_in.to_string()),
                quote_quantity: None,
                price: Some(limit_price.to_string()),
            })
        }
        // -------- Algo B · BUY: maximize fill --------
        (Algo::MaximizeFill, Side::Buy) => {
            // Market BUY sized by quote_quantity. KalqiX walks its own book up
            // to amount_in worth of quote. FOK ensures all-or-nothing — if the
            // book can't accommodate the full amount_in we get a non-fill and
            // refund cleanly rather than partial-state accounting.
            // We intentionally don't reference amount_out_min here because
            // KalqiX itself won't see that floor; the contract-equivalent
            // slippage check happens on our side after we read the fill data.
            let _ = amount_out_min;
            Ok(NewOrderBody {
                ticker,
                side: KalqiXSide::Buy,
                order_type: OrderType::Market,
                time_in_force: TIF_FOK,
                expires_at,
                quantity: None,
                quote_quantity: Some(amount_in.to_string()),
                price: None,
            })
        }
    }
}

fn u256_from_decimal(s: &str) -> Result<U256, AppError> {
    U256::from_str_radix(s.trim(), 10)
        .map_err(|e| AppError::Kalqix(format!("price not a decimal integer: {} · raw {:?}", e, s)))
}
