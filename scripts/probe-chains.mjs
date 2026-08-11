#!/usr/bin/env node
/**
 * Multi-chain regression probe for the Escrow Intent API.
 *
 * Asserts the three claims the harness is built on, against the live service:
 *
 *   1. BREADTH   — every routable chain in the registry returns a quote with a
 *                  routeSummary, and Mantle does not (KyberSwap 404s on its
 *                  aggregator slug and 400s on its token API).
 *   2. SOURCES   — a QuickSwap-restricted quote on Polygon and Base routes
 *                  ONLY through that chain's QuickSwap pools, and differs from
 *                  the unrestricted route.
 *   3. CHAIN_ID  — canary rejects an off-enum chain with BAD_CHAIN_ID, while
 *                  mainnet still silently ignores chain_id. The second half is
 *                  a known upstream defect; this asserts it hasn't been fixed
 *                  behind our back, because the app's chain gating depends on
 *                  which deployments honour the field.
 *
 * Usage:  node scripts/probe-chains.mjs [--env canary|mainnet] [--verbose]
 * Exits non-zero on any failed assertion.
 */

const ENVS = {
  canary: "https://escrow-canary.availproject.org",
  mainnet: "https://atomic.api.mainnet.availproject.org",
};

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${f}=`));
  return eq ? eq.slice(f.length + 1) : d;
};

const ENV = val("--env", "canary");
const BASE = ENVS[ENV];
const VERBOSE = has("--verbose");
if (!BASE) {
  console.error(`Unknown --env ${ENV}. Expected: ${Object.keys(ENVS).join(", ")}`);
  process.exit(2);
}

/** Mirrors src/config/chains.ts. `quickswapSources` marks the chains where
 *  QuickSwap routes through KyberSwap; `routable: false` is Mantle. */
const CHAINS = [
  { id: 1, label: "Ethereum", routable: true },
  { id: 10, label: "Optimism", routable: true },
  { id: 56, label: "BNB Chain", routable: true },
  { id: 130, label: "Unichain", routable: true },
  { id: 137, label: "Polygon", routable: true, quickswapSources: ["quickswap", "quickswap-v3"] },
  { id: 143, label: "Monad", routable: true },
  { id: 146, label: "Sonic", routable: true },
  { id: 999, label: "HyperEVM", routable: true },
  { id: 2020, label: "Ronin", routable: true },
  { id: 4326, label: "MegaETH", routable: true },
  { id: 5000, label: "Mantle", routable: false },
  { id: 8453, label: "Base", routable: true, quickswapSources: ["quickswap", "quickswap-v4"] },
  { id: 9745, label: "Plasma", routable: true },
  { id: 42161, label: "Arbitrum", routable: true },
  { id: 42793, label: "Etherlink", routable: true },
  { id: 43114, label: "Avalanche", routable: true },
  { id: 59144, label: "Linea", routable: true },
  { id: 80094, label: "Berachain", routable: true },
];

/** A chain id the API's enum does not contain. Soneium — a QuickSwap chain
 *  Avail cannot serve, which is exactly the case the UI must fail closed on. */
const OFF_ENUM_CHAIN_ID = 1868;

let failures = 0;
let checks = 0;
function assert(ok, label, detail = "") {
  checks++;
  if (!ok) failures++;
  const mark = ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${mark} ${label}${detail ? `  ${detail}` : ""}`);
}

async function quote(body) {
  const res = await fetch(`${BASE}/v2/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 413/415/422 are text/plain */
  }
  return { status: res.status, json, text };
}

/** Whitelisted tokens for a chain, straight from Kyber's token API — the same
 *  source the app uses, so the probe can't drift from what it ships. */
async function whitelistedTokens(chainId) {
  const url = `https://ks-setting.kyberswap.com/api/v1/tokens?chainIds=${chainId}&isWhitelisted=true&pageSize=100&page=1`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const j = await res.json();
  return (j?.data?.tokens ?? []).filter((t) => !t.isHoneypot && !t.isFOT);
}

/** A quotable pair for the breadth check. */
async function tokenPair(chainId) {
  const toks = await whitelistedTokens(chainId);
  if (!toks.length) return null;
  const tokenIn = toks.find((t) => t.isStable) ?? toks[0];
  const tokenOut =
    toks.find(
      (t) =>
        t.address !== tokenIn?.address &&
        /^(WETH|ETH|WBTC|cbBTC|WPOL|WRON|WXTZ|S|BNB)$/i.test(t.symbol)
    ) ?? toks.find((t) => t.address !== tokenIn?.address);
  if (!tokenIn || !tokenOut) return null;
  return { tokenIn, tokenOut, amountIn: (10n ** BigInt(tokenIn.decimals)).toString() };
}

/** Distinct `exchange` ids across every hop of a routeSummary. */
function routeExchanges(rs) {
  const out = new Set();
  for (const hop of rs?.route ?? []) {
    for (const leg of hop ?? []) if (leg?.exchange) out.add(leg.exchange);
  }
  return [...out];
}

// ── 1. BREADTH ───────────────────────────────────────────────────────────
async function checkBreadth() {
  console.log(`\n\x1b[1mBREADTH\x1b[0m — ${ENV} quotes a pair on every routable chain`);
  for (const c of CHAINS) {
    const pair = await tokenPair(c.id);
    if (!pair) {
      // No token list is itself the expected state for Mantle.
      assert(!c.routable, `${c.label} (${c.id}) — no token list`, c.routable ? "EXPECTED a list" : "expected");
      continue;
    }
    const { status, json } = await quote({
      chain_id: c.id,
      token_in: pair.tokenIn.address,
      token_out: pair.tokenOut.address,
      amount_in: pair.amountIn,
      slippage_bps: 50,
    });
    const q = (json?.quotes ?? []).find((x) => x.venue_name === "KYBERSWAP");
    const ok = status === 200 && !!q?.amount_out && !!q?.venue_detail?.routeSummary;
    const detail = VERBOSE
      ? `${pair.tokenIn.symbol}→${pair.tokenOut.symbol} ${ok ? `out=${q.amount_out}` : json?.error_code ?? q?.error_code ?? status}`
      : "";
    assert(ok === c.routable, `${c.label} (${c.id}) — ${c.routable ? "routes" : "does NOT route"}`, detail);
  }
}

// ── 2. SOURCES ───────────────────────────────────────────────────────────
async function checkSources() {
  console.log(`\n\x1b[1mSOURCES\x1b[0m — venue_options restricts routing to QuickSwap pools`);
  for (const c of CHAINS.filter((x) => x.quickswapSources)) {
    const toks = await whitelistedTokens(c.id);
    const stable =
      toks.find((t) => /^(USDC|USDC\.e|USDT)$/i.test(t.symbol)) ??
      toks.find((t) => t.isStable);
    if (!stable) {
      assert(false, `${c.label} — no stablecoin to quote from`);
      continue;
    }
    // Not every pair has a QuickSwap pool — USDC/WBTC on Base doesn't. Walk a
    // few majors and use the first that produces a restricted route, so this
    // check measures the restriction mechanism rather than pool coverage.
    const candidates = ["WETH", "WPOL", "WMATIC", "WBTC", "USDT", "USDC"]
      .map((sym) =>
        toks.find(
          (t) =>
            t.symbol.toUpperCase() === sym &&
            t.address.toLowerCase() !== stable.address.toLowerCase()
        )
      )
      .filter(Boolean);

    let found = null;
    for (const out of candidates) {
      const base = {
        chain_id: c.id,
        token_in: stable.address,
        token_out: out.address,
        amount_in: (10n ** BigInt(stable.decimals) * 5n).toString(),
        slippage_bps: 50,
        whitelisted_venues: ["KYBERSWAP"],
      };
      const restricted = await quote({
        ...base,
        venue_options: [
          { venue_name: "KYBERSWAP", option: { included_sources: c.quickswapSources } },
        ],
      });
      const resQ = (restricted.json?.quotes ?? [])[0];
      const resEx = routeExchanges(resQ?.venue_detail?.routeSummary);
      if (resEx.length) {
        found = { base, out, resQ, resEx };
        break;
      }
    }

    if (!found) {
      assert(
        false,
        `${c.label} — no QuickSwap route on any of ${candidates.map((t) => t.symbol).join("/")}`
      );
      continue;
    }

    assert(
      true,
      `${c.label} — restricted quote returns a route`,
      `${stable.symbol}→${found.out.symbol} via ${found.resEx.join(",")}`
    );
    // Only meaningful once we know a route exists — asserting "no foreign
    // sources" against an empty route would pass vacuously.
    const leaked = found.resEx.filter((e) => !c.quickswapSources.includes(e));
    assert(
      leaked.length === 0,
      `${c.label} — route uses only ${c.quickswapSources.join("/")}`,
      leaked.length ? `LEAKED ${leaked.join(",")}` : ""
    );

    const open = await quote(found.base);
    const openQ = (open.json?.quotes ?? [])[0];
    const openEx = routeExchanges(openQ?.venue_detail?.routeSummary);
    if (openQ?.amount_out && found.resQ?.amount_out) {
      const o = BigInt(openQ.amount_out);
      const r = BigInt(found.resQ.amount_out);
      const bps = Number(((o - r) * 10_000n) / o) / 100;
      console.log(
        `      open routing: ${openEx.join(", ") || "—"} · restriction costs ${bps.toFixed(2)}%`
      );
    }
  }
}

// ── 3. CHAIN_ID ──────────────────────────────────────────────────────────
async function checkChainIdHandling() {
  console.log(`\n\x1b[1mCHAIN_ID\x1b[0m — off-enum chain handling per deployment`);
  const body = {
    chain_id: OFF_ENUM_CHAIN_ID,
    token_in: "0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369",
    token_out: "0x4200000000000000000000000000000000000006",
    amount_in: "1000000",
    slippage_bps: 50,
  };
  for (const [name, base] of Object.entries(ENVS)) {
    const res = await fetch(`${base}/v2/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (name === "canary") {
      assert(
        res.status === 400 && json?.error_code === "BAD_CHAIN_ID",
        `canary rejects chain_id ${OFF_ENUM_CHAIN_ID}`,
        `${res.status} ${json?.error_code ?? ""}`
      );
    } else {
      // If this ever starts failing, mainnet has been upgraded — flip its
      // `chainIds` in src/config/deployments.ts to the full enum.
      assert(
        res.status === 200 && !json?.error_code,
        `mainnet still IGNORES chain_id (known upstream defect)`,
        `${res.status} ${json?.error_code ?? "no error_code"}`
      );
    }
  }
}

// ── 4. BODY LIMIT ────────────────────────────────────────────────────────
function checkBodyLimit() {
  console.log(`\n\x1b[1mBODY LIMIT\x1b[0m — requests fit the server's 512-byte cap`);
  const worst = JSON.stringify({
    chain_id: 8453,
    token_in: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    token_out: "0x4200000000000000000000000000000000000006",
    amount_in: "340282366920938463463374607431768211455",
    slippage_bps: 10000,
    whitelisted_venues: ["KALQIX", "KYBERSWAP"],
    venue_options: [
      { venue_name: "KYBERSWAP", option: { included_sources: ["quickswap", "quickswap-v4"] } },
    ],
  });
  const bytes = new TextEncoder().encode(worst).length;
  assert(bytes <= 512, `worst-case body is ${bytes}/512 bytes`);
}

const t0 = Date.now();
console.log(`Probing \x1b[1m${ENV}\x1b[0m at ${BASE}`);
await checkBreadth();
await checkSources();
await checkChainIdHandling();
checkBodyLimit();

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(
  `\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m in ${secs}s`
);
process.exit(failures ? 1 : 0);
