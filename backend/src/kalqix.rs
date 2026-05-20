//! KalqiX REST client with HMAC API auth + EIP-191 wallet signing on orders.
//!
//! Two layers of authentication every private request:
//!  1. **HMAC-SHA256** over `method | path | sorted_json_body | timestamp_ms`
//!     keyed by the API secret. Sent in `x-api-signature` along with
//!     `x-api-key` and `x-api-timestamp`. Documented in their HMAC guide.
//!  2. **EIP-191 personal-sign** over a per-action canonical payload, present
//!     in the order body itself as `signature`. Documented in their
//!     ethereum-signature guide. The signing key must match the EOA registered
//!     with the KalqiX account that owns the API key.
//!
//! Exact canonicalization rules below are inferred from the Explore findings
//! and need a one-time live verification — placing a tiny LIMIT order at an
//! unreachable price is the cheapest smoke-test. See README.md.

use crate::config::Config;
use crate::error::AppError;
use alloy::primitives::Address;
use alloy::signers::local::PrivateKeySigner;
use alloy::signers::Signer;
use hmac::{Hmac, Mac};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, warn};

type HmacSha256 = Hmac<Sha256>;

pub struct KalqiXClient {
    http: Client,
    base_url: String,
    api_key: String,
    api_secret: String,
    signer: PrivateKeySigner,
    market: String,
}

impl KalqiXClient {
    pub fn new(config: &Config) -> Self {
        let signer = PrivateKeySigner::from_str(&config.solver_private_key)
            .expect("SOLVER_PRIVATE_KEY must parse");
        Self {
            http: Client::new(),
            base_url: config.kalqix_base_url.clone(),
            api_key: config.kalqix_api_key.clone(),
            api_secret: config.kalqix_api_secret.clone(),
            signer,
            market: config.kalqix_market.clone(),
        }
    }

    pub fn solver_address(&self) -> Address {
        self.signer.address()
    }

    pub fn market(&self) -> &str {
        &self.market
    }

    // ---------- public market data (no auth) ----------

    pub async fn get_market(&self) -> Result<KalqiXMarket, AppError> {
        let path = format!("/markets/{}", percent_encode(&self.market));
        let url = format!("{}{}", self.base_url, path);
        let res = self.http.get(&url).send().await.map_err(net)?;
        if !res.status().is_success() {
            return Err(AppError::Kalqix(format!(
                "GET {} → {}",
                path,
                res.status()
            )));
        }
        res.json::<KalqiXMarket>().await.map_err(net)
    }

    pub async fn get_market_price(&self, side: KalqiXSide) -> Result<KalqiXPrice, AppError> {
        let path = format!(
            "/markets/{}/market-price?side={}",
            percent_encode(&self.market),
            side.as_str()
        );
        let url = format!("{}{}", self.base_url, path);
        let res = self.http.get(&url).send().await.map_err(net)?;
        if !res.status().is_success() {
            return Err(AppError::Kalqix(format!(
                "GET {} → {}",
                path,
                res.status()
            )));
        }
        res.json::<KalqiXPrice>().await.map_err(net)
    }

    // ---------- private: order placement + polling ----------

    /// Submit a NewOrder. Returns the server-assigned order_id. KalqiX is
    /// async: this returns once the order is accepted, NOT once it has filled.
    /// Caller must poll `get_order` to observe terminal state.
    pub async fn place_order(&self, req: NewOrderBody) -> Result<String, AppError> {
        // Build the body, then sign it (the signature is a field IN the body).
        let timestamp_ms = now_ms();
        let mut body = serde_json::to_value(&req).map_err(net)?;

        // Wallet-signature canonical: action + body + timestamp in sorted JSON,
        // EIP-191 personal-signed by the solver EOA. Goes into the body itself.
        let canonical_for_wallet = build_signing_payload(&body, timestamp_ms);
        let wallet_signature = self.eip191_sign_bytes(&canonical_for_wallet).await?;
        body["timestamp"] = json!(timestamp_ms);
        body["signature"] = json!(format!("0x{}", hex::encode(&wallet_signature)));

        debug!(?body, "placing order");
        let resp: OrderPlacementResponse = self
            .signed_request(reqwest::Method::POST, "/orders", Some(body))
            .await?;
        Ok(resp.order_id)
    }

    pub async fn get_order(&self, order_id: &str) -> Result<OrderDetail, AppError> {
        let path = format!("/orders/{}", order_id);
        self.signed_request(reqwest::Method::GET, &path, None).await
    }

    pub async fn get_order_trades(&self, order_id: &str) -> Result<TradesPage, AppError> {
        let path = format!("/orders/{}/trades", order_id);
        self.signed_request(reqwest::Method::GET, &path, None).await
    }

    // ---------- internals ----------

    async fn signed_request<T: serde::de::DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T, AppError> {
        let url = format!("{}{}", self.base_url, path);
        let timestamp = now_ms().to_string();
        let body_string = match &body {
            Some(v) => canonicalize_json(v),
            None => String::new(),
        };

        // Canonicalization rule (per Explore findings):
        //   "{METHOD}|{path with /v1/ prefix}|{sorted_json_body}|{timestamp_ms}"
        // The base_url already contains /v1; signed_path strips the host so we
        // include just the path segment with /v1 prefix.
        let signed_path = if path.starts_with("/v1") {
            path.to_string()
        } else {
            // Our base_url ends with /v1; the path doesn't include it. The HMAC
            // canonical needs the full request path including /v1.
            // Heuristic: if base_url contains "/v1", prepend it to path.
            if self.base_url.ends_with("/v1") {
                format!("/v1{}", path)
            } else {
                path.to_string()
            }
        };
        let canonical = format!(
            "{}|{}|{}|{}",
            method.as_str(),
            signed_path,
            body_string,
            timestamp
        );
        let signature = hmac_hex(&self.api_secret, &canonical);

        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("x-api-key"),
            HeaderValue::from_str(&self.api_key).map_err(internal)?,
        );
        headers.insert(
            HeaderName::from_static("x-api-signature"),
            HeaderValue::from_str(&signature).map_err(internal)?,
        );
        headers.insert(
            HeaderName::from_static("x-api-timestamp"),
            HeaderValue::from_str(&timestamp).map_err(internal)?,
        );
        if body.is_some() {
            headers.insert(
                HeaderName::from_static("content-type"),
                HeaderValue::from_static("application/json"),
            );
        }

        let mut req = self.http.request(method.clone(), &url).headers(headers);
        if let Some(b) = body {
            req = req.body(canonicalize_json(&b)); // send the exact bytes we signed
        }

        let res = req.send().await.map_err(net)?;
        let status = res.status();
        let text = res.text().await.map_err(net)?;

        if !status.is_success() {
            warn!(%status, body = %text, "kalqix request failed");
            return Err(AppError::Kalqix(format!(
                "{} {} → {} · {}",
                method, path, status, text
            )));
        }
        serde_json::from_str::<T>(&text).map_err(|e| {
            AppError::Kalqix(format!(
                "could not deserialize KalqiX response: {} · raw: {}",
                e, text
            ))
        })
    }

    /// Returns the full 65-byte EIP-191 signature (r || s || v) over `message`.
    pub async fn eip191_sign_bytes(&self, message: &str) -> Result<Vec<u8>, AppError> {
        let sig = self
            .signer
            .sign_message(message.as_bytes())
            .await
            .map_err(|e| AppError::Internal(format!("signer error: {}", e)))?;
        Ok(sig.as_bytes().to_vec())
    }
}

// ---------- canonicalization ----------

/// Reorder a JSON object's top-level keys alphabetically and emit compact JSON.
/// For nested objects, the JS canonicalizer in the Explore findings only sorts
/// the top level (`JSON.stringify(payload, Object.keys(payload).sort())` is a
/// top-level-only key filter in JS) — but to be safe we sort recursively.
fn canonicalize_json(v: &Value) -> String {
    let sorted = sort_value(v);
    serde_json::to_string(&sorted).unwrap_or_default()
}

fn sort_value(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), sort_value(&map[k]));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(sort_value).collect()),
        _ => v.clone(),
    }
}

fn hmac_hex(secret: &str, msg: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(msg.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// The per-order body that the EIP-191 signature covers. KalqiX's
/// ethereum-signature guide describes this as a canonicalized payload with
/// `action: "PLACE_ORDER"`. Exact format needs one-time live verification —
/// we follow the most idiomatic interpretation: sort-canonical JSON of the
/// order body fields + action + timestamp, then personal-sign that string.
fn build_signing_payload(body: &Value, timestamp_ms: u64) -> String {
    let mut wrapped = serde_json::Map::new();
    wrapped.insert("action".to_string(), json!("PLACE_ORDER"));
    wrapped.insert("body".to_string(), body.clone());
    wrapped.insert("timestamp".to_string(), json!(timestamp_ms));
    canonicalize_json(&Value::Object(wrapped))
}

fn percent_encode(s: &str) -> String {
    // KalqiX uses `cbBTC/USDC` style tickers with a literal slash. We encode
    // slashes as %2F so they don't terminate the path segment.
    s.replace('/', "%2F")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn net(e: impl std::fmt::Display) -> AppError {
    AppError::Kalqix(format!("{}", e))
}

fn internal(e: impl std::fmt::Display) -> AppError {
    AppError::Internal(format!("{}", e))
}

// ---------- types ----------

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum KalqiXSide {
    Buy,
    Sell,
}
impl KalqiXSide {
    fn as_str(&self) -> &'static str {
        match self {
            KalqiXSide::Buy => "BUY",
            KalqiXSide::Sell => "SELL",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum OrderType {
    Limit,
    Market,
}

/// time_in_force per KalqiX spec: 0=GTC, 1=IOC, 2=FOK. We use FOK exclusively.
pub const TIF_FOK: u8 = 2;

#[derive(Debug, Clone, Serialize)]
pub struct NewOrderBody {
    pub ticker: String,
    pub side: KalqiXSide,
    pub order_type: OrderType,
    pub time_in_force: u8,
    pub expires_at: u64,
    /// Base-asset quantity (base units, decimal string). LIMIT requires this;
    /// for MARKET BUY when sizing by quote, send None and use `quote_quantity`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantity: Option<String>,
    /// Quote-asset quantity (base units, decimal string). Only valid on MARKET
    /// orders. The maximize-fill BUY uses this.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote_quantity: Option<String>,
    /// LIMIT-only: price in quote base units per 1 base asset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OrderPlacementResponse {
    pub order_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OrderStatus {
    Pending,
    PartiallyFilled,
    Filled,
    CancellationRequested,
    Cancelled,
    Expired,
    ExpiredInMatch,
    Failed,
}

impl OrderStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            OrderStatus::Filled
                | OrderStatus::Cancelled
                | OrderStatus::Expired
                | OrderStatus::ExpiredInMatch
                | OrderStatus::Failed
        )
    }
    pub fn is_filled(&self) -> bool {
        matches!(self, OrderStatus::Filled)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct OrderDetail {
    pub order_id: String,
    pub status: OrderStatus,
    #[serde(default)]
    pub remaining_quantity: Option<String>,
    #[serde(default)]
    pub average_price: Option<String>,
    #[serde(default)]
    pub taker_fee_ppm: Option<u64>,
    #[serde(default)]
    pub maker_fee_ppm: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TradesPage {
    #[serde(default)]
    pub data: Vec<OrderTrade>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OrderTrade {
    pub trade_id: String,
    pub quantity: String,
    pub price: String,
    #[serde(default)]
    pub amount: Option<String>,
    #[serde(default)]
    pub fee: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub timestamp: Option<u64>,
}

// ---------- public market data types ----------

#[derive(Debug, Clone, Deserialize)]
pub struct KalqiXMarket {
    pub ticker: String,
    pub base_asset: String,
    pub quote_asset: String,
    pub base_asset_decimals: u8,
    pub quote_asset_decimals: u8,
    pub tick_size: String,
    pub step_size: String,
    pub min_quantity: String,
    pub min_trade_size: String,
    pub taker_fee: String,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KalqiXPrice {
    /// Quote-asset base units per 1 base asset, decimal integer string.
    pub price: String,
}
