//! Test-solver backend entrypoint. Loads config, builds clients, mounts the
//! axum router, and starts serving. All meaningful logic lives in the modules
//! this file glues together.

mod algo;
mod chain;
mod config;
mod error;
mod handlers;
mod kalqix;
mod state;

use crate::config::Config;
use crate::state::AppState;
use anyhow::Result;
use axum::http::{HeaderName, HeaderValue, Method};
use axum::Router;
use dashmap::DashMap;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Arc::new(Config::from_env()?);
    info!(
        bind_addr = %config.bind_addr,
        market = %config.kalqix_market,
        "starting test-solver"
    );

    let chain = Arc::new(chain::ChainClient::new(&config).await?);
    let kalqix = Arc::new(kalqix::KalqiXClient::new(&config));

    info!(
        solver_eoa = %chain.solver_address(),
        "chain client ready"
    );

    let state = AppState {
        config: config.clone(),
        kalqix,
        chain,
        swaps: Arc::new(DashMap::new()),
    };

    let cors = build_cors(&config.allowed_origins);
    let app = Router::new()
        .merge(handlers::routes())
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&config.bind_addr).await?;
    info!("listening on {}", config.bind_addr);
    axum::serve(listener, app).await?;
    Ok(())
}

fn build_cors(origins: &[String]) -> CorsLayer {
    let mut layer = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            HeaderName::from_static("content-type"),
            HeaderName::from_static("authorization"),
        ]);

    if origins.is_empty() {
        // No origins set → allow nothing (dev should set ALLOWED_ORIGINS).
        return layer;
    }
    for o in origins {
        if let Ok(v) = HeaderValue::from_str(o) {
            layer = layer.allow_origin(v);
        }
    }
    layer
}
