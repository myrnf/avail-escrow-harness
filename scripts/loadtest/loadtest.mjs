// Avail Escrow concurrency load-test — Canary, USDC -> cbBTC via EIP-2612 permit.
//
// Drives N wallets through the full swap flow (GET /quote -> permit -> POST
// /intent -> deposit tx -> poll to settlement) and reports per-intent timing so
// you can see whether concurrent intents settle in the same time a lone swap
// takes, and whether any error out.
//
// Usage (run from repo root):
//   node scripts/loadtest/loadtest.mjs balances          # preflight: balances/nonces (free)
//   node scripts/loadtest/loadtest.mjs baseline --go      # one wallet, end-to-end (spends)
//   node scripts/loadtest/loadtest.mjs concurrent --go    # ALL wallets at once (spends)
//
// Keys: scripts/loadtest/wallets.json (gitignored) — array of {label, privateKey}.
// Config via env: BASE_RPC, AMOUNT_IN (base units, default 11 USDC), SLIPPAGE_BPS,
//   WALLET (baseline wallet index, default 0).
//
// Spending modes require the --go flag (real funds on Base mainnet / Canary).

import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  parseSignature,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// ---- Canary constants (stable) ----
const CFG = {
  availBase: "https://escrow-canary.availproject.org",
  escrow: "0xDF06678Ca95fDBe30a719675779209B76370a1ee",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  rpc: process.env.BASE_RPC || "https://rpcs.avail.so/base",
  amountIn: BigInt(process.env.AMOUNT_IN || "11000000"), // 11 USDC
  slippageBps: Number(process.env.SLIPPAGE_BPS || "50"),
  usdcPermitVersion: "2", // Circle FiatTokenV2_2 signs with version "2"
  pollMs: 2000,
  pollTimeoutMs: 300_000,
};
const USDC_DECIMALS = 6;
const CBBTC_DECIMALS = 8;

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];
const eip712DomainAbi = [
  { type: "function", name: "eip712Domain", stateMutability: "view", inputs: [], outputs: [
    { type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" },
  ] },
];

const pub = createPublicClient({ chain: base, transport: http(CFG.rpc) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (v, d) => (Number(v) / 10 ** d).toFixed(d === 6 ? 4 : 8);

function loadWallets() {
  const path = new URL("./wallets.json", import.meta.url);
  let list;
  try {
    list = JSON.parse(readFileSync(path));
  } catch (e) {
    if (e?.code === "ENOENT") {
      throw new Error("scripts/loadtest/wallets.json not found — copy wallets.example.json and fill in the 10 keys (it's gitignored).");
    }
    throw e;
  }
  if (!Array.isArray(list) || !list.length) throw new Error("wallets.json empty");
  return list.map((w) => {
    const account = privateKeyToAccount(w.privateKey);
    return {
      label: w.label,
      account,
      address: account.address,
      wallet: createWalletClient({ account, chain: base, transport: http(CFG.rpc) }),
    };
  });
}

// ---- API ----
async function getQuote() {
  const p = new URLSearchParams({
    token_in: CFG.usdc.toLowerCase(),
    token_out: CFG.cbBTC.toLowerCase(),
    amount_in: CFG.amountIn.toString(),
    slippage_bps: String(CFG.slippageBps),
  });
  const r = await fetch(`${CFG.availBase}/quote?${p}`);
  const j = await r.json();
  if (j.error_code) throw new Error(`quote ${j.error_code}: ${j.error_message}`);
  const v = j.quotes?.[0];
  if (!v || v.error_code || !v.amount_out || v.amount_out === "0")
    throw new Error(`quote venue: ${v?.error_code || "no route"}`);
  return { amountOut: v.amount_out, amountOutMin: v.amount_out_min };
}

async function collectPermit(account, value, deadline) {
  let domain;
  try {
    const d = await pub.readContract({ address: CFG.usdc, abi: eip712DomainAbi, functionName: "eip712Domain" });
    domain = { name: d[1], version: d[2], chainId: Number(d[3]), verifyingContract: d[4] };
  } catch {
    const name = await pub.readContract({ address: CFG.usdc, abi: erc20Abi, functionName: "name" });
    domain = { name, version: CFG.usdcPermitVersion, chainId: base.id, verifyingContract: CFG.usdc };
  }
  const nonce = await pub.readContract({ address: CFG.usdc, abi: erc20Abi, functionName: "nonces", args: [account.address] });
  const types = {
    Permit: [
      { name: "owner", type: "address" }, { name: "spender", type: "address" },
      { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ],
  };
  const message = { owner: account.address, spender: CFG.escrow, value, nonce, deadline };
  const signature = await account.signTypedData({ domain, types, primaryType: "Permit", message });
  const parsed = parseSignature(signature);
  let v = parsed.v !== undefined ? Number(parsed.v) : parsed.yParity + 27;
  if (v < 27) v += 27;
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
    [deadline, v, parsed.r, parsed.s]
  );
}

async function createIntent(q, permit, label) {
  const r = await fetch(`${CFG.availBase}/intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token_in: CFG.usdc.toLowerCase(),
      token_out: CFG.cbBTC.toLowerCase(),
      amount_in: CFG.amountIn.toString(),
      amount_out: q.amountOutMin,
      amount_out_quote: q.amountOut,
      client_intent_id: `loadtest-${label}-${now()}`,
      permit,
    }),
  });
  const j = await r.json();
  if (j.error_code || !j.encoded_calldata) throw new Error(`intent ${j.error_code}: ${j.error_message}`);
  return j;
}

async function pollIntent(id) {
  const start = now();
  while (now() - start < CFG.pollTimeoutMs) {
    const r = await fetch(`${CFG.availBase}/intent/${id}`);
    if (r.ok) {
      const d = await r.json();
      const s = d.settlement?.status;
      const o = d.order?.status;
      if (d.expired) return { terminal: "EXPIRED", d };
      if (s === "SETTLED") return { terminal: "SETTLED", d };
      if (s === "UNLOCKED") return { terminal: "UNLOCKED", d };
      if (s === "FAILED_TO_SETTLE" || s === "FAILED_TO_UNLOCK") return { terminal: s, d };
      if (o === "FAILED") return { terminal: "ORDER_FAILED", d };
    }
    await sleep(CFG.pollMs);
  }
  return { terminal: "TIMEOUT", d: null };
}

// ---- Flow phases (timestamps recorded into ctx.t) ----
async function stage(ctx) {
  const t = ctx.t;
  t.t0 = now();
  ctx.quote = await getQuote();
  t.tQuote = now();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  ctx.permit = await collectPermit(ctx.account, CFG.amountIn, deadline);
  t.tPermit = now();
  ctx.intent = await createIntent(ctx.quote, ctx.permit, ctx.label);
  t.tIntent = now();
  ctx.intentId = ctx.intent.id;
}

async function execute(ctx) {
  const t = ctx.t;
  const hash = await ctx.wallet.sendTransaction({
    to: ctx.intent.contract_address,
    data: ctx.intent.encoded_calldata,
    value: 0n,
  });
  ctx.depositTx = hash;
  t.tDepositSent = now();
  const receipt = await pub.waitForTransactionReceipt({ hash });
  ctx.depositStatus = receipt.status;
  t.tDepositConfirmed = now();
  const res = await pollIntent(ctx.intentId);
  t.tSettled = now();
  ctx.terminal = res.terminal;
  ctx.settlementTx = res.d?.settlement?.tx_hash ?? null;
  ctx.amountOutActual = res.d?.settlement?.amount_out ?? res.d?.order?.amount_out ?? null;
  ctx.error = res.terminal === "SETTLED" ? null : (res.d?.settlement?.error_message || res.d?.order?.error_message || res.terminal);
}

function newCtx(w) {
  return { ...w, t: {}, terminal: null, error: null };
}

async function runOne(w) {
  const ctx = newCtx(w);
  try {
    await stage(ctx);
    await execute(ctx);
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
    permit: d("tQuote", "tPermit"),
    intent: d("tPermit", "tIntent"),
    depConf: d("tDepositSent", "tDepositConfirmed"),
    settle: d("tDepositConfirmed", "tSettled"), // Avail solver+settlement time
    total: d("t0", "tSettled"),
  };
}
const ms = (v) => (v == null ? "—" : `${(v / 1000).toFixed(1)}s`);

function report(ctxs) {
  console.log("\n=== per-intent ===");
  for (const c of ctxs) {
    const d = durations(c.t);
    console.log(
      `  ${c.label} ${short(c.address)}  ${c.terminal.padEnd(14)}` +
      ` quote=${ms(d.quote)} permit=${ms(d.permit)} intent=${ms(d.intent)}` +
      ` depConf=${ms(d.depConf)} settle=${ms(d.settle)} total=${ms(d.total)}`
    );
    if (c.depositTx) console.log(`       deposit:    https://basescan.org/tx/${c.depositTx}`);
    if (c.settlementTx) console.log(`       settlement: https://basescan.org/tx/${c.settlementTx}`);
    if (c.amountOutActual) console.log(`       received:   ${fmt(c.amountOutActual, CBBTC_DECIMALS)} cbBTC`);
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
async function modeBalances(wallets) {
  console.log(`\n=== balances (${wallets.length} wallets, Canary/Base) ===`);
  for (const w of wallets) {
    const [eth, usdc, nonce] = await Promise.all([
      pub.getBalance({ address: w.address }),
      pub.readContract({ address: CFG.usdc, abi: erc20Abi, functionName: "balanceOf", args: [w.address] }),
      pub.readContract({ address: CFG.usdc, abi: erc20Abi, functionName: "nonces", args: [w.address] }),
    ]);
    const enough = usdc >= CFG.amountIn && eth > 0n;
    console.log(`  ${w.label} ${short(w.address)}  USDC=${fmt(usdc, USDC_DECIMALS)}  ETH=${(Number(eth) / 1e18).toFixed(6)}  permitNonce=${nonce}  ${enough ? "✓" : "⚠ INSUFFICIENT"}`);
  }
  console.log(`\n  swap amount_in = ${fmt(CFG.amountIn, USDC_DECIMALS)} USDC each · slippage ${CFG.slippageBps}bps`);
}

async function modeBaseline(wallets) {
  const idx = Number(process.env.WALLET || "0");
  const w = wallets[idx];
  console.log(`\n=== BASELINE: 1 swap on ${w.label} ${short(w.address)} (${fmt(CFG.amountIn, USDC_DECIMALS)} USDC → cbBTC) ===`);
  const ctx = await runOne(w);
  report([ctx]);
}

async function modeConcurrent(wallets) {
  console.log(`\n=== CONCURRENT: ${wallets.length} swaps fired together (${fmt(CFG.amountIn, USDC_DECIMALS)} USDC → cbBTC each) ===`);
  const ctxs = wallets.map(newCtx);
  // Phase 1: stage all (quote + permit + intent) concurrently.
  console.log("  staging intents…");
  await Promise.all(ctxs.map(async (c) => {
    try { await stage(c); } catch (e) { c.terminal = "STAGE_ERROR"; c.error = String(e?.message || e); }
  }));
  const staged = ctxs.filter((c) => c.intent && !c.error);
  console.log(`  staged ${staged.length}/${ctxs.length}; bursting deposits…`);
  // Phase 2: fire all deposits + track to settlement concurrently (tight burst).
  await Promise.all(staged.map(async (c) => {
    try { await execute(c); } catch (e) { c.terminal = c.terminal || "EXEC_ERROR"; c.error = String(e?.message || e); }
  }));
  report(ctxs);
}

async function main() {
  const mode = process.argv[2];
  const go = process.argv.includes("--go");
  if (!["balances", "baseline", "concurrent"].includes(mode)) {
    console.log("usage: node scripts/loadtest/loadtest.mjs <balances|baseline|concurrent> [--go]");
    return;
  }
  const wallets = loadWallets();

  if (mode === "balances") return modeBalances(wallets);
  if (mode === "baseline" || mode === "concurrent") {
    if (!go) {
      console.log(`\n⚠  '${mode}' spends REAL funds on Canary. Re-run with --go to proceed.`);
      console.log(`   ${wallets.length} wallets loaded · ${fmt(CFG.amountIn, USDC_DECIMALS)} USDC each · RPC ${CFG.rpc}`);
      return;
    }
    if (mode === "baseline") return modeBaseline(wallets);
    return modeConcurrent(wallets);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
