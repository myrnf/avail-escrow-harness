//! Env-driven config. Loaded once at startup; held in AppState.

use alloy::primitives::Address;
use anyhow::{Context, Result};
use std::env;
use std::str::FromStr;

#[derive(Debug, Clone)]
pub struct Config {
    pub kalqix_api_key: String,
    pub kalqix_api_secret: String,
    pub kalqix_base_url: String,
    pub kalqix_market: String,

    /// Hex-encoded private key, no 0x prefix. Used for both KalqiX order
    /// signatures and Base mainnet inventory transfers.
    pub solver_private_key: String,

    pub base_rpc_url: String,

    pub allowed_origins: Vec<String>,

    /// Per-swap caps in token base units.
    pub max_swap_usdc: u128,
    pub max_swap_cbbtc: u128,

    pub usdc_address: Address,
    pub cbbtc_address: Address,

    pub admin_bearer_token: String,
    pub bind_addr: String,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        // Best-effort load .env (no error if not present — Render injects env directly).
        let _ = dotenvy::dotenv();

        Ok(Self {
            kalqix_api_key: require("KALQIX_API_KEY")?,
            kalqix_api_secret: require("KALQIX_API_SECRET")?,
            kalqix_base_url: optional("KALQIX_BASE_URL", "https://api.kalqix.com/v1"),
            kalqix_market: optional("KALQIX_MARKET", "cbBTC/USDC"),

            solver_private_key: normalize_priv_key(&require("SOLVER_PRIVATE_KEY")?),
            base_rpc_url: optional("BASE_RPC_URL", "https://mainnet.base.org"),

            allowed_origins: optional("ALLOWED_ORIGINS", "")
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),

            max_swap_usdc: parse_u128("MAX_SWAP_USDC", "50000000")?,
            max_swap_cbbtc: parse_u128("MAX_SWAP_CBBTC", "60000")?,

            usdc_address: parse_addr(
                "USDC_ADDRESS",
                "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            )?,
            cbbtc_address: parse_addr(
                "CBBTC_ADDRESS",
                "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
            )?,

            admin_bearer_token: optional("ADMIN_BEARER_TOKEN", ""),
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| {
                // Render injects PORT; honor it if BIND_ADDR isn't set.
                match env::var("PORT") {
                    Ok(p) => format!("0.0.0.0:{}", p),
                    Err(_) => "0.0.0.0:3000".to_string(),
                }
            }),
        })
    }
}

fn require(key: &str) -> Result<String> {
    env::var(key).with_context(|| format!("required env var {} is unset", key))
}

fn optional(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn parse_u128(key: &str, default: &str) -> Result<u128> {
    let s = optional(key, default);
    s.parse()
        .with_context(|| format!("env var {} = {:?} must parse as u128", key, s))
}

fn parse_addr(key: &str, default: &str) -> Result<Address> {
    let s = optional(key, default);
    Address::from_str(&s).with_context(|| format!("env var {} = {:?} must parse as address", key, s))
}

/// Strip optional 0x prefix + whitespace from the private key. alloy's signer
/// expects 64 hex chars; users frequently paste with the standard prefix.
fn normalize_priv_key(raw: &str) -> String {
    raw.trim().trim_start_matches("0x").trim_start_matches("0X").to_string()
}
