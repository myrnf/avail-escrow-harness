# Two-stage build: cargo-cached deps in stage 1, tiny runtime in stage 2.

FROM rust:1.82-slim AS builder
WORKDIR /app

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

# Just ca-certs; reqwest uses rustls so no libssl needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/test-solver /usr/local/bin/test-solver

# Render injects $PORT and the bind addr honors it via config.rs.
EXPOSE 3000
CMD ["test-solver"]
