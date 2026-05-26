# Two-stage build: cargo-cached deps in stage 1, tiny runtime in stage 2.

# `rust:1-slim` tracks the latest stable Rust. Necessary because alloy and its
# transitive deps (ruint, base64ct) pin recent MSRV. Pinning a specific 1.x
# minor here keeps breaking with every minor that those deps bump.
FROM rust:1-slim AS builder
WORKDIR /app

# System build deps. openssl-sys is pulled transitively (likely from alloy's
# `full` feature even though reqwest uses rustls); pkg-config + libssl-dev
# satisfy it. Cleaner than chasing the offending crate to disable defaults.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      pkg-config libssl-dev build-essential \
 && rm -rf /var/lib/apt/lists/*

# Cache dependency compilation: build with a dummy main.rs so deps are compiled
# and cached in a layer. Subsequent edits to src/ only rebuild the crate itself.
COPY Cargo.toml ./
RUN mkdir src && echo "fn main(){}" > src/main.rs \
 && cargo build --release \
 && rm -rf src target/release/test-solver target/release/deps/test_solver*

# Real source
COPY src/ src/
RUN cargo build --release

# ─────────────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime
WORKDIR /app

# ca-certs for TLS root validation; libssl3 because something in alloy's
# default feature set ends up dynamically linked against system openssl.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/test-solver /usr/local/bin/test-solver

# Render injects $PORT and the bind addr honors it via config.rs.
EXPOSE 3000
CMD ["test-solver"]
