// Avail Escrow concurrency load-test — USDC <-> cbBTC / ETH across
// testnet/canary/mainnet. KALQIX venue only.
//
// Drives N wallets through the full swap flow (POST /v2/quote -> permit|approve
// -> POST /intent -> deposit tx -> poll GET /v2/intent to settlement) and
// reports per-intent timing so you can see whether concurrent intents settle in
// the same time a lone swap takes, and whether any error out.
//
// Usage (run from repo root):
//   node scripts/loadtest/loadtest.mjs balances    [--env testnet|canary|mainnet]
//   node scripts/loadtest/loadtest.mjs baseline     [--env ..] [--dir usdc-to-cbbtc|cbbtc-to-usdc|usdc-to-eth|eth-to-usdc] [--wallet 0] [--go]
//   node scripts/loadtest/loadtest.mjs concurrent   [--env ..] [--dir ..] [--exclude w1,w6] [--go]
//
// Keys: scripts/loadtest/wallets.json (gitignored) — array of {label, privateKey}.
// Env vars: BASE_RPC (overrides per-env RPC), AMOUNT_IN (input-token base units),
//   SLIPPAGE_BPS.
//
// --go is required only for REAL-money envs (canary, mainnet). testnet is free.

import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  parseSignature,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
// Native ETH has no ERC-20 contract — Avail's asset registry and the escrow's
// ETH_ADDRESS both match on this sentinel. Same value on every chain.
const ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// Per-environment config. `usePermit` false → approve fallback (testnet tokens
// are KalqiX test deployments without EIP-2612).
const ENVS = {
  testnet: {
    key: "testnet", label: "Testnet (Base Sepolia)", chain: baseSepolia,
    availBase: "https://avail-escrow-test.availproject.org",
    escrow: "0xDF06678Ca95fDBe30a719675779209B76370a1ee",
    usdc: "0x94d655f6cc102d1e7e3f7a0e66fa604779ca8306",
    cbBTC: "0xe58c5488de4d67dfb186ef955d412ff4473451a8",
    usePermit: false, realMoney: false,
    explorer: "https://sepolia.basescan.org",
    defaultRpc: "https://base-sepolia.drpc.org",
  },
  canary: {
    key: "canary", label: "Canary (Base mainnet)", chain: base,
    availBase: "https://escrow-canary.availproject.org",
    escrow: "0xDF06678Ca95fDBe30a719675779209B76370a1ee",
    usdc: USDC, cbBTC: CBBTC, usePermit: true, realMoney: true,
    explorer: "https://basescan.org",
    defaultRpc: "https://rpcs.avail.so/base",
  },
  mainnet: {
    key: "mainnet", label: "Mainnet (Base)", chain: base,
    availBase: "https://atomic.api.mainnet.availproject.org",
    escrow: "0x74aED8C89b09bd96d87Add00744340289A1Ae90e",
    usdc: USDC, cbBTC: CBBTC, usePermit: true, realMoney: true,
    explorer: "https://basescan.org",
    defaultRpc: "https://rpcs.avail.so/base",
  },
};

const CFG = {
  amountInOverride: process.env.AMOUNT_IN ? BigInt(process.env.AMOUNT_IN) : null,
  defaultUsdcIn: 11_000_000n, // 11 USDC
  defaultEthIn: 5_000_000_000_000_000n, // 0.005 ETH — above KalqiX min_quantity
  slippageBps: Number(process.env.SLIPPAGE_BPS || "50"),
  permitVersion: "2",
  pollMs: 2000,
  pollTimeoutMs: 300_000,
  // Left unspent when selling "all" native ETH, so the deposit tx can pay gas
  // (msg.value must equal amount_in exactly, so it can't come out of the swap).
  nativeGasReserve: 300_000_000_000_000n, // 0.0003 ETH
};

// KalqiX ETH_USDC quantises the ETH (base) side to step_size 0.00000001 ETH,
// which is 1e10 wei because ETH carries 18 decimals — unlike cbBTC, where the
// same step equals 1 base unit and so never binds. The orchestrator floors an
// unaligned amount_in and returns the aligned value, so we always adopt the
// amount_in it echoes back rather than the one we asked for. These mirror the
// live market and are advisory only — the server validates authoritatively.
const ETH_STEP_WEI = 10_000_000_000n;
const ETH_MIN_QTY_WEI = 4_200_000_000_000_000n; // 0.0042 ETH
// Quote-asset notional floor, shared by both markets.
const USDC_MIN_TRADE_SIZE = 8_000_000n; // 8 USDC

// tokenIn is always the token being spent (permit/approve on it, unless native).
const DIRECTIONS = {
  "usdc-to-cbbtc": { key: "usdc-to-cbbtc", in: "usdc", out: "cbBTC", inSym: "USDC", outSym: "cbBTC", inDec: 6, outDec: 8 },
  "cbbtc-to-usdc": { key: "cbbtc-to-usdc", in: "cbBTC", out: "usdc", inSym: "cbBTC", outSym: "USDC", inDec: 8, outDec: 6 },
  "usdc-to-eth": { key: "usdc-to-eth", in: "usdc", out: "eth", inSym: "USDC", outSym: "ETH", inDec: 6, outDec: 18 },
  "eth-to-usdc": { key: "eth-to-usdc", in: "eth", out: "usdc", inSym: "ETH", outSym: "USDC", inDec: 18, outDec: 6 },
};

/** Native ETH input: paid as msg.value, never permitted or approved. */
const isNativeIn = (dir) => dir.in === "eth";

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];
const eip712DomainAbi = [
  { type: "function", name: "eip712Domain", stateMutability: "view", inputs: [], outputs: [
    { type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" },
  ] },
];

// Resolved in main() once --env is known.
let ENV = ENVS.canary;
let pub;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (v, d) => (Number(v) / 10 ** d).toFixed(d <= 6 ? 4 : 8);
const addrOf = (which) =>
  which === "usdc" ? ENV.usdc : which === "eth" ? ETH_SENTINEL : ENV.cbBTC;

function argVal(name, def = null) {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === name) return process.argv[i + 1] ?? def;
    if (a.startsWith(name + "=")) return a.slice(name.length + 1);
  }
  return def;
}
const hasFlag = (name) => process.argv.includes(name);
const norm = (s) => s.toLowerCase().replace(/\d+/g, (m) => String(parseInt(m, 10)));

function loadWallets() {
  const path = new URL("./wallets.json", import.meta.url);
  let list;
  try {
    list = JSON.parse(readFileSync(path));
  } catch (e) {
    if (e?.code === "ENOENT")
      throw new Error("scripts/loadtest/wallets.json not found — copy wallets.example.json and fill in the keys (it's gitignored).");
    throw e;
  }
  if (!Array.isArray(list) || !list.length) throw new Error("wallets.json empty");
  return list.map((w) => {
    const account = privateKeyToAccount(w.privateKey);
    return {
      label: w.label,
      account,
      address: account.address,
      wallet: createWalletClient({ account, chain: ENV.chain, transport: http(ENV.rpc) }),
    };
  });
}

function filterWallets(wallets, excludeStr) {
  if (!excludeStr) return { included: wallets, excluded: [] };
  const ex = new Set(excludeStr.split(",").map((s) => norm(s.trim())).filter(Boolean));
  return {
    included: wallets.filter((w) => !ex.has(norm(w.label))),
    excluded: wallets.filter((w) => ex.has(norm(w.label))),
  };
}

const balanceOf = (token, owner) =>
  pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });

// ---- API ----
/** JSON body or text/plain — 413/415/422 and JSON-syntax 400s answer in text. */
async function readJson(r, what) {
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} ${r.status}: ${text.slice(0, 120)}`);
  }
}

async function getQuote(dir, amountIn) {
  const r = await fetch(`${ENV.availBase}/v2/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token_in: addrOf(dir.in).toLowerCase(),
      token_out: addrOf(dir.out).toLowerCase(),
      amount_in: amountIn.toString(),
      slippage_bps: CFG.slippageBps,
      whitelisted_venues: ["KALQIX"],
      venue_options: null,
    }),
  });
  const j = await readJson(r, "POST /v2/quote");
  if (j.error_code) throw new Error(`quote ${j.error_code}: ${j.error_message}`);
  const v = j.quotes?.find((q) => q.venue_name === "KALQIX");
  if (!v || v.error_code || !v.amount_out || v.amount_out === "0")
    throw new Error(`quote venue: ${v?.error_code || "no route / amount too small"}`);
  if (!v.amount_out_min) throw new Error("quote returned no amount_out_min");
  return {
    // KalqiX-aligned input — differs from the requested amount whenever the
    // market's step size binds (ETH). msg.value and the permit must both use
    // this, or the escrow reverts on the amount_in mismatch.
    amountIn: BigInt(v.amount_in ?? amountIn),
    amountOut: v.amount_out,
    amountOutMin: v.amount_out_min,
  };
}

async function collectPermit(tokenAddr, account, value, deadline) {
  let domain;
  try {
    const d = await pub.readContract({ address: tokenAddr, abi: eip712DomainAbi, functionName: "eip712Domain" });
    domain = { name: d[1], version: d[2], chainId: Number(d[3]), verifyingContract: d[4] };
  } catch {
    const name = await pub.readContract({ address: tokenAddr, abi: erc20Abi, functionName: "name" });
    domain = { name, version: CFG.permitVersion, chainId: ENV.chain.id, verifyingContract: tokenAddr };
  }
  const nonce = await pub.readContract({ address: tokenAddr, abi: erc20Abi, functionName: "nonces", args: [account.address] });
  const types = {
    Permit: [
      { name: "owner", type: "address" }, { name: "spender", type: "address" },
      { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ],
  };
  const message = { owner: account.address, spender: ENV.escrow, value, nonce, deadline };
  const signature = await account.signTypedData({ domain, types, primaryType: "Permit", message });
  const parsed = parseSignature(signature);
  let v = parsed.v !== undefined ? Number(parsed.v) : parsed.yParity + 27;
  if (v < 27) v += 27;
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
    [deadline, v, parsed.r, parsed.s]
  );
}

// approve fallback (testnet). Idempotent — skips if allowance already covers.
async function approveIfNeeded(ctx, tokenAddr, amount) {
  const allowance = await pub.readContract({
    address: tokenAddr, abi: erc20Abi, functionName: "allowance",
    args: [ctx.address, ENV.escrow],
  });
  if (allowance >= amount) return;
  const hash = await ctx.wallet.writeContract({
    address: tokenAddr, abi: erc20Abi, functionName: "approve", args: [ENV.escrow, amount],
  });
  ctx.approveTx = hash;
  await pub.waitForTransactionReceipt({ hash });
}

async function createIntent(dir, amountIn, q, permit, label) {
  const r = await fetch(`${ENV.availBase}/intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token_in: addrOf(dir.in).toLowerCase(),
      token_out: addrOf(dir.out).toLowerCase(),
      amount_in: amountIn.toString(),
      amount_out: q.amountOutMin,
      amount_out_quote: q.amountOut,
      client_intent_id: `loadtest-${label}-${now()}`,
      permit,
      venue: "KALQIX",
    }),
  });
  const j = await readJson(r, "POST /intent");
  if (j.error_code || !j.encoded_calldata) throw new Error(`intent ${j.error_code}: ${j.error_message}`);
  return j;
}

async function pollIntent(id) {
  const start = now();
  while (now() - start < CFG.pollTimeoutMs) {
    const r = await fetch(`${ENV.availBase}/v2/intent/${id}`);
    // 404 right after creation just means the row isn't visible yet.
    if (r.ok) {
      const d = await r.json();
      const trade = d.trade_outcome;
      const settle = d.settlement_outcome;
      // Settlement is the last word, so it's checked first; a trade can
      // succeed and settlement still fail.
      if (settle === "FUNDS_SETTLED") return { terminal: "SETTLED", d };
      if (settle === "FUNDS_UNLOCKED") return { terminal: "UNLOCKED", d };
      if (settle === "FAILURE") {
        const act = d.settlement_details?.action;
        return { terminal: act === "UNLOCK" ? "UNLOCK_FAILED" : "SETTLE_FAILED", d };
      }
      if (trade === "NO_MATCH_FOUND") return { terminal: "NO_MATCH", d };
      if (trade === "TTL_EXPIRED") return { terminal: "TTL_EXPIRED", d };
      if (trade === "FAILURE") return { terminal: "ORDER_FAILED", d };
      // Expired with neither leg started, or any other decided outcome.
      if (d.expired && trade === "NOT_INITIATED" && settle === "NOT_INITIATED")
        return { terminal: "EXPIRED", d };
      if (d.outcome && d.outcome !== "NOT_DETERMINED")
        return { terminal: d.outcome, d };
    }
    await sleep(CFG.pollMs);
  }
  return { terminal: "TIMEOUT", d: null };
}

async function resolveAmountIn(dir, address) {
  if (CFG.amountInOverride != null) return CFG.amountInOverride;
  if (dir.key === "cbbtc-to-usdc") return balanceOf(addrOf(dir.in), address); // full cbBTC balance
  if (dir.key === "eth-to-usdc") {
    // Fixed size rather than the whole balance: ETH is also the gas token, so
    // draining it would strand the wallet for the next run. Capped by what's
    // spendable after the gas reserve, and floored to the step.
    const bal = await pub.getBalance({ address });
    const spendable = bal > CFG.nativeGasReserve ? bal - CFG.nativeGasReserve : 0n;
    const want = CFG.defaultEthIn < spendable ? CFG.defaultEthIn : spendable;
    return (want / ETH_STEP_WEI) * ETH_STEP_WEI;
  }
  return CFG.defaultUsdcIn;
}

// ---- Flow phases (timestamps into ctx.t) ----
async function stage(ctx, dir) {
  const t = ctx.t;
  const inAddr = addrOf(dir.in);
  t.t0 = now();
  ctx.amountIn = await resolveAmountIn(dir, ctx.address);
  if (ctx.amountIn <= 0n) throw new Error(`no ${dir.inSym} balance to swap`);
  if (isNativeIn(dir) && ctx.amountIn < ETH_MIN_QTY_WEI)
    throw new Error(
      `${fmt(ctx.amountIn, 18)} ETH is below KalqiX min_quantity ${fmt(ETH_MIN_QTY_WEI, 18)} ETH`
    );
  ctx.quote = await getQuote(dir, ctx.amountIn);
  // Adopt the KalqiX-aligned input the quote came back with: everything
  // downstream (permit value, intent amount_in, msg.value) must agree with it.
  if (ctx.quote.amountIn !== ctx.amountIn) {
    ctx.amountInRequested = ctx.amountIn;
    ctx.amountIn = ctx.quote.amountIn;
  }
  t.tQuote = now();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  if (isNativeIn(dir)) {
    ctx.permit = null; // native is paid as msg.value; the escrow forbids a permit
  } else if (ENV.usePermit) {
    ctx.permit = await collectPermit(inAddr, ctx.account, ctx.amountIn, deadline);
  } else {
    ctx.permit = null;
    await approveIfNeeded(ctx, inAddr, ctx.amountIn); // one-time on-chain approve
  }
  t.tPermit = now();
  ctx.intent = await createIntent(dir, ctx.amountIn, ctx.quote, ctx.permit, ctx.label);
  t.tIntent = now();
  ctx.intentId = ctx.intent.id;
}

async function execute(ctx, dir) {
  const t = ctx.t;
  const hash = await ctx.wallet.sendTransaction({
    to: ctx.intent.contract_address,
    data: ctx.intent.encoded_calldata,
    // deposit() requires msg.value == amount_in exactly for native input, and
    // zero for ERC-20s (it reverts InvalidMsgValue otherwise).
    value: isNativeIn(dir) ? ctx.amountIn : 0n,
  });
  ctx.depositTx = hash;
  t.tDepositSent = now();
  const receipt = await pub.waitForTransactionReceipt({ hash });
  ctx.depositStatus = receipt.status;
  t.tDepositConfirmed = now();
  const res = await pollIntent(ctx.intentId);
  t.tSettled = now();
  ctx.terminal = res.terminal;
  ctx.settlementTx = res.d?.settlement_details?.tx_hash ?? null;
  ctx.amountOutActual =
    res.d?.settlement_details?.amount ?? res.d?.trade_details?.order_amount ?? null;
  ctx.error =
    res.terminal === "SETTLED"
      ? null
      : res.d?.settlement_details?.error_message ||
        res.d?.trade_details?.error_message ||
        res.terminal;
}

const newCtx = (w) => ({ ...w, t: {}, amountIn: null, terminal: null, error: null });

async function runOne(w, dir) {
  const ctx = newCtx(w);
  try {
    await stage(ctx, dir);
    await execute(ctx, dir);
  } catch (e) {
    ctx.terminal = ctx.terminal || "ERROR";
    ctx.error = String(e?.message || e);
  }
  return ctx;
}

// ---- Reporting ----
function durations(t) {
  const d = (a, b) => (t[a] != null && t[b] != null ? t[b] - t[a] : null);
  return {
    quote: d("t0", "tQuote"),
    prep: d("tQuote", "tPermit"), // permit sign or approve tx
    intent: d("tPermit", "tIntent"),
    depConf: d("tDepositSent", "tDepositConfirmed"),
    settle: d("tDepositConfirmed", "tSettled"), // Avail solver+settlement time
    total: d("t0", "tSettled"),
  };
}
const ms = (v) => (v == null ? "—" : `${(v / 1000).toFixed(1)}s`);

function report(ctxs, dir) {
  console.log(`\n=== per-intent (${ENV.key}: ${dir.inSym} → ${dir.outSym}) ===`);
  for (const c of ctxs) {
    const d = durations(c.t);
    // Flag when KalqiX's step size moved the input off what we asked for.
    const aligned =
      c.amountInRequested != null
        ? ` (aligned from ${fmt(c.amountInRequested, dir.inDec)})`
        : "";
    const inAmt =
      c.amountIn != null ? `${fmt(c.amountIn, dir.inDec)} ${dir.inSym}${aligned}` : "—";
    console.log(
      `  ${c.label} ${short(c.address)}  ${String(c.terminal).padEnd(14)} in=${inAmt}` +
      `  quote=${ms(d.quote)} prep=${ms(d.prep)} intent=${ms(d.intent)}` +
      ` depConf=${ms(d.depConf)} settle=${ms(d.settle)} total=${ms(d.total)}`
    );
    if (c.depositTx) console.log(`       deposit:    ${ENV.explorer}/tx/${c.depositTx}`);
    if (c.settlementTx) console.log(`       settlement: ${ENV.explorer}/tx/${c.settlementTx}`);
    if (c.amountOutActual) console.log(`       received:   ${fmt(c.amountOutActual, dir.outDec)} ${dir.outSym}`);
    if (c.error) console.log(`       ERROR: ${c.error}`);
  }
  const ok = ctxs.filter((c) => c.terminal === "SETTLED");
  const bad = ctxs.filter((c) => c.terminal !== "SETTLED");
  const settles = ok.map((c) => durations(c.t).settle).filter((v) => v != null).sort((a, b) => a - b);
  console.log("\n=== summary ===");
  console.log(`  settled: ${ok.length}/${ctxs.length}   failed: ${bad.length}`);
  if (settles.length) {
    const med = settles[Math.floor(settles.length / 2)];
    console.log(`  deposit→settled (Avail exec):  min ${ms(settles[0])}  median ${ms(med)}  max ${ms(settles.at(-1))}`);
  }
  if (bad.length) console.log(`  failures: ${bad.map((c) => `${c.label}=${c.terminal}`).join(", ")}`);
}

// ---- Modes ----
/** Why this wallet can't run `dir`, or null if it can. Mirrors the checks the
 *  market would apply, so a preflight catches what would otherwise fail mid-run
 *  (KalqiX min_trade_size / min_quantity, and gas). */
function notReadyReason(dir, { eth, usdc, cbbtc }) {
  if (eth === 0n) return "no ETH for gas";
  if (dir.in === "usdc") {
    const want = CFG.amountInOverride ?? CFG.defaultUsdcIn;
    if (usdc < want) return `needs ${fmt(want, 6)} USDC, has ${fmt(usdc, 6)}`;
    if (want < USDC_MIN_TRADE_SIZE)
      return `amount_in below market min_trade_size ${fmt(USDC_MIN_TRADE_SIZE, 6)} USDC`;
    return null;
  }
  if (dir.in === "cbBTC") {
    return cbbtc === 0n ? "no cbBTC to sell" : null;
  }
  // Native ETH: gas reserve comes off the top, and the remainder must clear
  // KalqiX's ETH min_quantity.
  const spendable = eth > CFG.nativeGasReserve ? eth - CFG.nativeGasReserve : 0n;
  const want = CFG.amountInOverride ?? CFG.defaultEthIn;
  const usable = want < spendable ? want : spendable;
  if (usable < ETH_MIN_QTY_WEI)
    return `spendable ${fmt(usable, 18)} ETH below min_quantity ${fmt(ETH_MIN_QTY_WEI, 18)}`;
  return null;
}

async function modeBalances(wallets, dir) {
  console.log(`\n=== balances (${ENV.label}, ${wallets.length} wallets) ===`);
  const blocked = [];
  for (const w of wallets) {
    const [eth, usdc, cbbtc] = await Promise.all([
      pub.getBalance({ address: w.address }),
      balanceOf(ENV.usdc, w.address),
      balanceOf(ENV.cbBTC, w.address),
    ]);
    const why = notReadyReason(dir, { eth, usdc, cbbtc });
    if (why) blocked.push(w.label);
    console.log(
      `  ${w.label} ${short(w.address)}  USDC=${fmt(usdc, 6)}  cbBTC=${fmt(cbbtc, 8)}` +
      `  ETH=${(Number(eth) / 1e18).toFixed(6)}  ${why ? `⚠ ${why}` : "✓"}`
    );
  }
  console.log(
    `\n  ready for ${dir.inSym}→${dir.outSym}: ${wallets.length - blocked.length}/${wallets.length}`
  );
  if (blocked.length)
    console.log(`  skip them with:  --exclude ${blocked.join(",")}`);
}

async function modeBaseline(wallets, dir) {
  const idx = Number(argVal("--wallet", "0"));
  const w = wallets[idx];
  console.log(`\n=== BASELINE: 1 swap on ${w.label} ${short(w.address)} (${ENV.key}: ${dir.inSym} → ${dir.outSym}) ===`);
  report([await runOne(w, dir)], dir);
}

async function modeConcurrent(wallets, dir) {
  const { included, excluded } = filterWallets(wallets, argVal("--exclude", ""));
  if (excluded.length) console.log(`  excluding: ${excluded.map((w) => w.label).join(", ")}`);
  if (!included.length) return console.log("  no wallets left after --exclude.");
  console.log(`\n=== CONCURRENT: ${included.length} swaps fired together (${ENV.key}: ${dir.inSym} → ${dir.outSym}) ===`);
  const ctxs = included.map(newCtx);
  console.log(`  staging intents…${ENV.usePermit ? "" : " (approve where needed)"}`);
  await Promise.all(ctxs.map(async (c) => {
    try { await stage(c, dir); } catch (e) { c.terminal = "STAGE_ERROR"; c.error = String(e?.message || e); }
  }));
  const staged = ctxs.filter((c) => c.intent && !c.error);
  console.log(`  staged ${staged.length}/${ctxs.length}; bursting deposits…`);
  await Promise.all(staged.map(async (c) => {
    try { await execute(c, dir); } catch (e) { c.terminal = c.terminal || "EXEC_ERROR"; c.error = String(e?.message || e); }
  }));
  report(ctxs, dir);
}

async function main() {
  const mode = process.argv[2];
  if (!["balances", "baseline", "concurrent"].includes(mode)) {
    console.log(`usage: node scripts/loadtest/loadtest.mjs <balances|baseline|concurrent> [--env testnet|canary|mainnet] [--dir ${Object.keys(DIRECTIONS).join("|")}] [--exclude w1,w6] [--wallet N] [--go]`);
    return;
  }
  const envKey = argVal("--env", "canary");
  if (!ENVS[envKey]) return console.log(`unknown --env '${envKey}' (use testnet|canary|mainnet)`);
  ENV = ENVS[envKey];
  ENV.rpc = process.env.BASE_RPC || ENV.defaultRpc;
  pub = createPublicClient({ chain: ENV.chain, transport: http(ENV.rpc) });

  const dir = DIRECTIONS[argVal("--dir", "usdc-to-cbbtc")];
  if (!dir) return console.log(`unknown --dir (use ${Object.keys(DIRECTIONS).join(", ")})`);
  const wallets = loadWallets();

  if (mode === "balances") return modeBalances(wallets, dir);
  if (ENV.realMoney && !hasFlag("--go")) {
    console.log(`\n⚠  '${mode}' on ${ENV.label} spends REAL funds. Re-run with --go to proceed.`);
    console.log(`   ${dir.inSym}→${dir.outSym} · ${wallets.length} wallets · RPC ${ENV.rpc}`);
    return;
  }
  if (mode === "baseline") return modeBaseline(wallets, dir);
  return modeConcurrent(wallets, dir);
}

main().catch((e) => { console.error(e); process.exit(1); });
