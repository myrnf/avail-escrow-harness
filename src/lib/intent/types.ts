import type { Address, Hex } from "viem";
import type { Venue } from "../../config/deployments";

// ─────────────────────────────────────────────────────────────────────────
// POST /intent
// ─────────────────────────────────────────────────────────────────────────

export interface CreateIntentRequest {
  /** EVM chain to execute on. The API defaults to Base (8453) when omitted,
   *  but we always send it — a deployment that ignores the field is a
   *  wrong-chain quote wearing a 200, so being explicit costs nothing and the
   *  probe script can assert on it. */
  chain_id?: number;
  token_in: Address;
  token_out: Address;
  amount_in: string;
  /** The slippage-floored minimum acceptable output (enforced on-chain). */
  amount_out: string;
  /** Optional: the gross expected output before slippage. Free telemetry for Avail. */
  amount_out_quote?: string | null;
  client_intent_id?: string | null;
  /** EIP-2612 permit blob, hex-encoded. Spec limit 2000 chars. KALQIX only. */
  permit?: string | null;
  // ── Multi-venue fields (v2 envs only). OMIT entirely — not null — on the
  // legacy mainnet backend, which may reject unknown keys.
  /** Executing venue; the backend defaults to KALQIX when omitted. */
  venue?: Venue;
  /** REQUIRED for KYBERSWAP: `{ routeSummary }` passed back verbatim from the
   *  /v2/quote venue_detail — same object reference, never rebuilt. */
  venue_detail?: { routeSummary?: unknown } | null;
  /** REQUIRED for KYBERSWAP: the tx sender + output recipient. Must equal the
   *  connected wallet that will send the router tx. Ignored for KALQIX. */
  user_wallet?: Address | null;
}

/** Avail Escrow `/intent` error codes (OpenAPI enum). String widened with
 *  `& {}` so unknown codes from older / newer deployments still type-check. */
export type IntentErrorCode =
  | "BAD_TOKEN_IN"
  | "BAD_TOKEN_OUT"
  | "BAD_AMOUNT_IN"
  | "BAD_AMOUNT_OUT"
  | "BAD_AMOUNT_OUT_QUOTE"
  | "BAD_PERMIT"
  | "BAD_CLIENT_INTENT_ID"
  | "NO_ASSET_FOUND_FOR_TOKEN_IN"
  | "NO_ASSET_FOUND_FOR_TOKEN_OUT"
  | "ASSETS_ARE_THE_SAME"
  | "NO_MARKET_FOUND"
  | "MIN_QTY_VIOLATION"
  | "TICK_SIZE_VIOLATION"
  | "STEP_SIZE_VIOLATION"
  | "MIN_TRADE_VIOLATION"
  | "MAX_TRADE_VIOLATION"
  | "INTERNAL_ERROR"
  | "INTERNAL_SERVER_ERROR"
  | "TOKEN_IN_NOT_SUPPORTED"
  | "TOKEN_OUT_NOT_SUPPORTED"
  | "AMOUNT_IN_BELOW_MIN_AMOUNT"
  | "AMOUNT_IN_ABOVE_MAX_AMOUNT"
  | "BAD_VENUE"
  | "BAD_VENUE_DETAIL"
  | "BAD_USER_WALLET"
  | "BAD_CHAIN_ID"
  | "SERVICE_UNAVAILABLE"
  | (string & {});

/** Canonical (post-spec-v0.1.0) flat response shape. Same schema is returned
 *  on success and on error — discriminated by whether `error_code` is null. */
export interface CreateIntentResponse {
  id: string | null;
  encoded_calldata: Hex | null;
  contract_address: Address | null;
  solver_address: Address | null;
  transaction_value: string | null;
  error_code: IntentErrorCode | null;
  error_message: string | null;
}

/** Narrowed success-only view exposed to callers.
 *  KALQIX: contract_address = escrow, solver_address set, transaction_value
 *  null. KYBERSWAP: contract_address = Kyber router, solver_address null,
 *  transaction_value = native value string to send with the router tx. */
export interface CreateIntentSuccess {
  id: string;
  encoded_calldata: Hex;
  contract_address: Address;
  solver_address: Address | null;
  /** Optional: legacy envelope responses don't carry it at all. */
  transaction_value?: string | null;
}

// ── Legacy wrapped envelope (canary on the older deployment may still emit this).
// Kept for backward compatibility; the client transparently accepts either shape.
export interface IntentApiError {
  kind: string;
  message: string;
}
export interface CreateIntentEnvelope {
  success: CreateIntentSuccess | null;
  error: IntentApiError | null;
}

// ─────────────────────────────────────────────────────────────────────────
// GET /intent/{id}
// ─────────────────────────────────────────────────────────────────────────

export type OrderStatus = "UNKNOWN" | "PENDING" | "SUCCESS" | "FAILED";

export type SettlementStatus =
  | "UNKNOWN"
  | "PENDING"
  | "SETTLED"
  | "UNLOCKED"
  | "FAILED_TO_UNLOCK"
  | "FAILED_TO_SETTLE";

export interface IntentInput {
  client_intent_id: string | null;
  token_in: Address;
  token_out: Address;
  amount_in: string;
  amount_out: string;
  amount_out_quote: string | null;
  permit: string | null;
}

export interface OrderOutcome {
  status: OrderStatus;
  error_code: number | null;
  error_message: string | null;
  amount_out: string | null;
  amount_out_formatted: string | null;
  amount_out_id: number;
  amount_out_decimals: number | null;
  amount_out_symbol: string | null;
}

export interface SettlementOutcome {
  status: SettlementStatus;
  error_code: number | null;
  error_message: string | null;
  amount_out: string | null;
  tx_hash: Hex | null;
  approval_tx_hash: Hex | null;
}

export interface IntentDetail {
  intent_id: string;
  input: IntentInput;
  order: OrderOutcome;
  settlement: SettlementOutcome;
}

// ─────────────────────────────────────────────────────────────────────────
// Terminal-state helpers
// ─────────────────────────────────────────────────────────────────────────

export function isOrderTerminal(o: OrderOutcome): boolean {
  return o.status === "SUCCESS" || o.status === "FAILED";
}

export function isSettlementTerminal(s: SettlementOutcome): boolean {
  return (
    s.status === "SETTLED" ||
    s.status === "UNLOCKED" ||
    s.status === "FAILED_TO_UNLOCK" ||
    s.status === "FAILED_TO_SETTLE"
  );
}

export type IntentTerminal =
  | { kind: "settled"; settlementTx: Hex; approvalTx: Hex | null }
  | { kind: "unlocked"; tx: Hex | null }
  | { kind: "failed"; where: "order" | "settlement"; reason: string }
  | null;

/** Returns a single normalized terminal verdict, or null if still in flight.
 *  Settlement-side terminal states take precedence over order-side. */
export function terminalVerdict(d: IntentDetail): IntentTerminal {
  const s = d.settlement;
  if (s.status === "SETTLED") {
    return {
      kind: "settled",
      settlementTx: s.tx_hash ?? ("0x" as Hex),
      approvalTx: s.approval_tx_hash,
    };
  }
  if (s.status === "UNLOCKED") {
    return { kind: "unlocked", tx: s.tx_hash };
  }
  if (s.status === "FAILED_TO_SETTLE" || s.status === "FAILED_TO_UNLOCK") {
    return {
      kind: "failed",
      where: "settlement",
      reason: s.error_message ?? s.status,
    };
  }

  if (d.order.status === "FAILED") {
    return {
      kind: "failed",
      where: "order",
      reason: d.order.error_message ?? "FAILED",
    };
  }

  return null;
}
