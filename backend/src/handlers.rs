//! HTTP handlers + per-swap orchestration. The whole state machine lives here
//! because each transition is paired with an HTTP touchpoint or background task.

use crate::algo::{self, Algo};
use crate::error::AppError;
use crate::kalqix::{KalqiXClient, OrderDetail, OrderStatus};
use crate::state::{AppState, FillData, Side, Swap, SwapStatus};
use alloy::primitives::{Address, B256, U256};
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::sync::Arc;
use tracing::{error, info, warn};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/swap-request", post(swap_request))
        .route("/swap/:id/deposit-tx", post(deposit_tx))
        .route("/swap/:id", get(get_swap))
        .route("/admin/swaps", get(admin_list))
}

// ───────────────────────────────────────────────────────────────────────
// GET /health
// ───────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    market: String,
    solver: Address,
    inventory: crate::chain::InventorySnapshot,
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let inventory = state.chain.inventory_snapshot().await;
    Json(HealthResponse {
        status: "ok",
        market: state.config.kalqix_market.clone(),
        solver: state.chain.solver_address(),
        inventory,
    })
}

// ───────────────────────────────────────────────────────────────────────
// POST /swap-request
// ───────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SwapRequestBody {
    token_in: Address,
    token_out: Address,
    /// base units, decimal string
    amount_in: String,
    /// base units, decimal string
    amount_out_min: String,
    /// optional gross expected output, base units
    amount_out_quote: Option<String>,
    algo: Algo,
    user_eoa: Address,
}

#[derive(Serialize)]
struct SwapRequestResponse {
    swap_id: Uuid,
    recipient_eoa: Address,
    expires_at: chrono::DateTime<Utc>,
}

async fn swap_request(
    State(state): State<AppState>,
    Json(body): Json<SwapRequestBody>,
) -> Result<Json<SwapRequestResponse>, AppError> {
    // Resolve direction.
    let (side, cap) = if body.token_in == state.config.usdc_address
        && body.token_out == state.config.cbbtc_address
    {
        (Side::Buy, state.config.max_swap_usdc)
    } else if body.token_in == state.config.cbbtc_address
        && body.token_out == state.config.usdc_address
    {
        (Side::Sell, state.config.max_swap_cbbtc)
    } else {
        return Err(AppError::Validation(format!(
            "unsupported token pair: {} → {}",
            body.token_in, body.token_out
        )));
    };

    let amount_in = U256::from_str_radix(&body.amount_in, 10)
        .map_err(|_| AppError::Validation("amount_in not an integer".into()))?;
    let amount_out_min = U256::from_str_radix(&body.amount_out_min, 10)
        .map_err(|_| AppError::Validation("amount_out_min not an integer".into()))?;
    let amount_out_quote = body
        .amount_out_quote
        .as_deref()
        .map(|s| U256::from_str_radix(s, 10))
        .transpose()
        .map_err(|_| AppError::Validation("amount_out_quote not an integer".into()))?;

    if amount_in.is_zero() {
        return Err(AppError::Validation("amount_in must be > 0".into()));
    }
    if amount_in > U256::from(cap) {
        return Err(AppError::Validation(format!(
            "amount_in {} exceeds harness cap {}",
            amount_in, cap
        )));
    }

    // Reject if user already has an active (non-terminal) swap. Prevents the
    // wallet from racing concurrent deposits.
    for entry in state.swaps.iter() {
        let s = entry.value();
        if s.user_eoa == body.user_eoa && !s.status.is_terminal() {
            return Err(AppError::Validation(format!(
                "user {} already has active swap {} (status {:?})",
                body.user_eoa, s.id, s.status
            )));
        }
    }

    let now = Utc::now();
    let id = Uuid::new_v4();
    let swap = Swap {
        id,
        user_eoa: body.user_eoa,
        algo: body.algo,
        side,
        token_in: body.token_in,
        token_out: body.token_out,
        amount_in,
        amount_out_min,
        amount_out_quote,
        recipient_eoa: state.chain.solver_address(),
        created_at: now,
        expires_at: now + Duration::minutes(5),
        status: SwapStatus::Requested,
        steps: vec![crate::state::StepRecord {
            at: now,
            status: SwapStatus::Requested,
            note: Some(format!("algo={}", body.algo.label())),
        }],
        deposit_tx_hash: None,
        payout_tx_hash: None,
        refund_tx_hash: None,
        fill: FillData::default(),
        error: None,
    };
    state.swaps.insert(id, swap);

    info!(swap_id = %id, side = ?side, algo = %body.algo.label(), "swap requested");

    Ok(Json(SwapRequestResponse {
        swap_id: id,
        recipient_eoa: state.chain.solver_address(),
        expires_at: now + Duration::minutes(5),
    }))
}

// ───────────────────────────────────────────────────────────────────────
// POST /swap/{id}/deposit-tx
// ───────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct DepositTxBody {
    tx_hash: String,
}

async fn deposit_tx(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<DepositTxBody>,
) -> Result<Json<Swap>, AppError> {
    let tx_hash = B256::from_str(&body.tx_hash)
        .map_err(|_| AppError::Validation("tx_hash must be 0x-prefixed 32-byte hex".into()))?;

    // Snapshot the swap details we need; mutate later. Avoid holding the
    // DashMap lock across awaits.
    let (token_in, user_eoa, amount_in) = {
        let entry = state
            .swaps
            .get(&id)
            .ok_or_else(|| AppError::NotFound(format!("swap {}", id)))?;
        let s = entry.value();

        // Idempotency: if we've already accepted this hash, just return state.
        if s.deposit_tx_hash == Some(tx_hash) {
            return Ok(Json(s.clone()));
        }
        if s.status != SwapStatus::Requested && s.status != SwapStatus::AwaitingDeposit {
            return Err(AppError::Validation(format!(
                "swap not in deposit-awaiting state: {:?}",
                s.status
            )));
        }
        (s.token_in, s.user_eoa, s.amount_in)
    };

    // Mark as AwaitingDeposit + record the tx hash. The actual verification
    // call below can take a few seconds (block confirmation).
    if let Some(mut entry) = state.swaps.get_mut(&id) {
        entry.deposit_tx_hash = Some(tx_hash);
        entry.transition(SwapStatus::AwaitingDeposit, Some(format!("tx={}", tx_hash)));
    }

    // Verify the deposit. If it's not yet mined, return the current state and
    // let the client retry. If it reverted or mismatches, fail the swap.
    match state
        .chain
        .verify_deposit(tx_hash, token_in, user_eoa, amount_in)
        .await
    {
        Ok(received) => {
            info!(swap_id = %id, received = %received, "deposit verified");
            if let Some(mut entry) = state.swaps.get_mut(&id) {
                entry.transition(
                    SwapStatus::DepositConfirmed,
                    Some(format!("received {}", received)),
                );
            }
            // Kick off background order execution + payout.
            tokio::spawn(execute_swap(state.clone(), id));
        }
        Err(AppError::Validation(msg)) if msg.contains("not yet mined") => {
            // Soft failure — client should poll and call again. State already
            // reflects AwaitingDeposit, so just return it.
        }
        Err(e) => {
            // Hard failure on the deposit (revert, wrong recipient, wrong amount, etc.).
            // No funds at risk yet because the tx didn't actually land where we expected.
            if let Some(mut entry) = state.swaps.get_mut(&id) {
                entry.error = Some(format!("{}", e));
                entry.transition(SwapStatus::Failed, Some("deposit verification failed".into()));
            }
            return Err(e);
        }
    }

    let entry = state
        .swaps
        .get(&id)
        .ok_or_else(|| AppError::NotFound(format!("swap {}", id)))?;
    Ok(Json(entry.value().clone()))
}

// ───────────────────────────────────────────────────────────────────────
// GET /swap/{id}
// ───────────────────────────────────────────────────────────────────────

async fn get_swap(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Swap>, AppError> {
    let entry = state
        .swaps
        .get(&id)
        .ok_or_else(|| AppError::NotFound(format!("swap {}", id)))?;
    Ok(Json(entry.value().clone()))
}

// ───────────────────────────────────────────────────────────────────────
// GET /admin/swaps
// ───────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct AdminListResponse {
    swaps: Vec<Swap>,
}

async fn admin_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminListResponse>, AppError> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    if state.config.admin_bearer_token.is_empty()
        || token != state.config.admin_bearer_token
    {
        return Err(AppError::Unauthorized);
    }
    let mut swaps: Vec<Swap> = state.swaps.iter().map(|e| e.value().clone()).collect();
    swaps.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(Json(AdminListResponse { swaps }))
}

// ───────────────────────────────────────────────────────────────────────
// Background: order placement + payout
// ───────────────────────────────────────────────────────────────────────

async fn execute_swap(state: AppState, id: Uuid) {
    let (algo, side, amount_in, amount_out_min, token_out, user_eoa, token_in) = {
        let entry = match state.swaps.get(&id) {
            Some(e) => e,
            None => return,
        };
        let s = entry.value();
        (
            s.algo,
            s.side,
            s.amount_in,
            s.amount_out_min,
            s.token_out,
            s.user_eoa,
            s.token_in,
        )
    };

    // --- Build & place the KalqiX order ---
    let order_body = match algo::build_order(
        &state.kalqix,
        algo,
        side,
        amount_in,
        amount_out_min,
    )
    .await
    {
        Ok(b) => b,
        Err(e) => return fail_with_refund(&state, id, token_in, user_eoa, amount_in, &e).await,
    };

    let order_id = match state.kalqix.place_order(order_body).await {
        Ok(oid) => oid,
        Err(e) => return fail_with_refund(&state, id, token_in, user_eoa, amount_in, &e).await,
    };

    info!(swap_id = %id, %order_id, "kalqix order placed");
    if let Some(mut entry) = state.swaps.get_mut(&id) {
        entry.fill.order_id = Some(order_id.clone());
        entry.transition(SwapStatus::OrderPlaced, Some(format!("order_id={}", order_id)));
    }

    // --- Poll for terminal state ---
    let order = match poll_until_terminal(&state.kalqix, &order_id).await {
        Ok(o) => o,
        Err(e) => return fail_with_refund(&state, id, token_in, user_eoa, amount_in, &e).await,
    };

    if !order.status.is_filled() {
        let msg = format!("order terminal but not filled: {:?}", order.status);
        warn!(swap_id = %id, %order_id, "{}", msg);
        return fail_with_refund(
            &state,
            id,
            token_in,
            user_eoa,
            amount_in,
            &AppError::Kalqix(msg),
        )
        .await;
    }

    // --- Read trade data ---
    let trades = match state.kalqix.get_order_trades(&order_id).await {
        Ok(t) => t,
        Err(e) => return fail_with_refund(&state, id, token_in, user_eoa, amount_in, &e).await,
    };

    let (filled_base, filled_quote, fee_total) = summarize_trades(&trades.data);

    if let Some(mut entry) = state.swaps.get_mut(&id) {
        entry.fill.filled_quantity_base = Some(filled_base.to_string());
        entry.fill.filled_quantity_quote = Some(filled_quote.to_string());
        entry.fill.taker_fee_paid = Some(fee_total.to_string());
        entry.fill.average_price = order.average_price.clone();
        entry.transition(SwapStatus::Filled, None);
    }

    // --- Compute payout to user ---
    // KalqiX charges fees in the QUOTE asset (USDC), not in the receive
    // asset. Empirically: on a 12 USDC → cbBTC BUY, trade.fee was ~8400
    // base units = 0.0084 USDC ≈ 0.07% of 12 USDC. So:
    //   BUY: solver received the full quantity in base (cbBTC). Deliver
    //        filled_base to user; the fee was extra USDC the solver paid.
    //   SELL: solver received quote minus fee. Deliver filled_quote − fee.
    let payout = match side {
        Side::Buy => filled_base,
        Side::Sell => filled_quote.saturating_sub(fee_total),
    };
    info!(
        swap_id = %id,
        side = ?side,
        filled_base = %filled_base,
        filled_quote = %filled_quote,
        fee_total = %fee_total,
        payout = %payout,
        "trade summary"
    );

    if payout < amount_out_min {
        // Defensive: shouldn't normally happen for FOK Algo A (we sized to
        // clear exactly amount_out_min). Could happen for Algo B if the book
        // depth is unusual. Refund rather than under-deliver.
        let msg = format!(
            "computed payout {} < amount_out_min {} after fees",
            payout, amount_out_min
        );
        warn!(swap_id = %id, "{}", msg);
        return fail_with_refund(
            &state,
            id,
            token_in,
            user_eoa,
            amount_in,
            &AppError::Internal(msg),
        )
        .await;
    }

    if let Some(mut entry) = state.swaps.get_mut(&id) {
        entry.fill.net_payout = Some(payout.to_string());
        entry.transition(SwapStatus::PayoutBroadcast, None);
    }

    // --- Deliver output to user ---
    match state.chain.transfer_erc20(token_out, user_eoa, payout).await {
        Ok(hash) => {
            info!(swap_id = %id, %hash, "payout delivered");
            if let Some(mut entry) = state.swaps.get_mut(&id) {
                entry.payout_tx_hash = Some(hash);
                entry.transition(SwapStatus::Complete, Some(format!("payout={}", hash)));
            }
        }
        Err(e) => {
            error!(swap_id = %id, "payout failed: {}", e);
            // We've taken the user's funds AND have a filled position on KalqiX,
            // but the chain transfer failed. Hard failure — operator must
            // resolve manually. We mark FAILED but the inventory state is now
            // inconsistent.
            if let Some(mut entry) = state.swaps.get_mut(&id) {
                entry.error = Some(format!(
                    "payout transfer failed AFTER kalqix fill — operator intervention required: {}",
                    e
                ));
                entry.transition(SwapStatus::Failed, Some("payout broadcast failed".into()));
            }
        }
    }
}

async fn fail_with_refund(
    state: &AppState,
    id: Uuid,
    token_in: Address,
    user_eoa: Address,
    amount_in: U256,
    cause: &AppError,
) {
    warn!(swap_id = %id, error = %cause, "failing swap with refund");

    let refund_result = state.chain.transfer_erc20(token_in, user_eoa, amount_in).await;
    if let Some(mut entry) = state.swaps.get_mut(&id) {
        entry.error = Some(format!("{}", cause));
        match refund_result {
            Ok(hash) => {
                entry.refund_tx_hash = Some(hash);
                entry.transition(SwapStatus::Failed, Some(format!("refund={}", hash)));
            }
            Err(e) => {
                error!(swap_id = %id, "refund failed: {}", e);
                entry.error = Some(format!(
                    "primary error: {} · refund also failed: {}",
                    cause, e
                ));
                entry.transition(SwapStatus::Failed, Some("refund failed".into()));
            }
        }
    }
}

async fn poll_until_terminal(
    client: &Arc<KalqiXClient>,
    order_id: &str,
) -> Result<OrderDetail, AppError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
    loop {
        let detail = client.get_order(order_id).await?;
        if detail.status.is_terminal() {
            return Ok(detail);
        }
        if std::time::Instant::now() >= deadline {
            return Err(AppError::Kalqix(format!(
                "order {} did not reach terminal state within 45s",
                order_id
            )));
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    }
}

fn summarize_trades(trades: &[crate::kalqix::OrderTrade]) -> (U256, U256, U256) {
    let mut filled_base = U256::ZERO;
    let mut filled_quote = U256::ZERO;
    let mut fee = U256::ZERO;
    for t in trades {
        let qty = parse_u256(&t.quantity);
        let px = parse_u256(&t.price);
        let amt = t.amount.as_deref().map(parse_u256).unwrap_or(qty * px);
        let f = t.fee.as_deref().map(parse_u256).unwrap_or(U256::ZERO);
        filled_base += qty;
        filled_quote += amt;
        fee += f;
    }
    (filled_base, filled_quote, fee)
}

fn parse_u256(s: &str) -> U256 {
    U256::from_str_radix(s.trim(), 10).unwrap_or(U256::ZERO)
}
