//! AppState — handles to KalqiX client, chain client, in-flight swap registry.

use crate::algo::Algo;
use crate::chain::ChainClient;
use crate::config::Config;
use crate::kalqix::KalqiXClient;
use alloy::primitives::{Address, B256, U256};
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub kalqix: Arc<KalqiXClient>,
    pub chain: Arc<ChainClient>,
    pub swaps: Arc<DashMap<Uuid, Swap>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Side {
    /// USDC → cbBTC (the path where underspend can happen on Algo A)
    Buy,
    /// cbBTC → USDC (algos behave identically on this side)
    Sell,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SwapStatus {
    /// Created via POST /swap-request; awaiting user's deposit tx hash.
    Requested,
    /// User reported tx hash; backend verifying receipt + amount + sender.
    AwaitingDeposit,
    /// Deposit confirmed onchain; about to place KalqiX order.
    DepositConfirmed,
    /// KalqiX order placed; polling for fill.
    OrderPlaced,
    /// Order filled on KalqiX; computing payout.
    Filled,
    /// Payout tx broadcast to user.
    PayoutBroadcast,
    /// Payout tx confirmed onchain. Terminal happy path.
    Complete,
    /// Anything went wrong. If user funds reached us, a refund tx is included.
    Failed,
}

impl SwapStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, SwapStatus::Complete | SwapStatus::Failed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepRecord {
    pub at: DateTime<Utc>,
    pub status: SwapStatus,
    pub note: Option<String>,
}

/// Result data we capture for the execution-quality comparison.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FillData {
    /// KalqiX order id.
    pub order_id: Option<String>,
    /// Sum of fill quantities, in base-asset base units.
    pub filled_quantity_base: Option<String>,
    /// Sum of (fill quantity × fill price), in quote-asset base units.
    pub filled_quantity_quote: Option<String>,
    /// Average fill price (raw, quote-asset base units per 1 base asset).
    pub average_price: Option<String>,
    /// Total fee paid (units depend on KalqiX side).
    pub taker_fee_paid: Option<String>,
    /// Net amount delivered to user — base or quote depending on side.
    pub net_payout: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Swap {
    pub id: Uuid,
    pub user_eoa: Address,
    pub algo: Algo,
    pub side: Side,

    pub token_in: Address,
    pub token_out: Address,
    /// User-committed input, base units.
    pub amount_in: U256,
    /// On-chain slippage floor (== amount_out_min the frontend computed).
    pub amount_out_min: U256,
    /// Gross expected output, for execution-quality comparison.
    pub amount_out_quote: Option<U256>,

    pub recipient_eoa: Address,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,

    pub status: SwapStatus,
    pub steps: Vec<StepRecord>,
    pub deposit_tx_hash: Option<B256>,
    pub payout_tx_hash: Option<B256>,
    pub refund_tx_hash: Option<B256>,
    pub fill: FillData,
    pub error: Option<String>,
}

impl Swap {
    pub fn transition(&mut self, status: SwapStatus, note: Option<String>) {
        if self.status == status {
            return; // idempotent
        }
        self.status = status;
        self.steps.push(StepRecord {
            at: Utc::now(),
            status,
            note,
        });
    }
}
