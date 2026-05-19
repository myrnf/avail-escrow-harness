import type { Address, Hex } from "viem";

// ─────────────────────────────────────────────────────────────────────────
// POST /intent
// ─────────────────────────────────────────────────────────────────────────

export interface CreateIntentRequest {
  token_in: Address;
  token_out: Address;
  amount_in: string;
  /** The slippage-floored minimum acceptable output (enforced on-chain). */
  amount_out: string;
  /** Optional: the gross expected output before slippage. Free telemetry for Avail. */
  amount_out_quote?: string | null;
  client_intent_id?: string | null;
  permit?: string | null;
}

export interface CreateIntentSuccess {
  id: string;
  encoded_calldata: Hex;
  contract_address: Address;
  solver_address: Address;
}

export type IntentErrorKind =
  | "INVALID_REQUEST"
  | "INTERNAL_ERROR"
  | string;

export interface IntentApiError {
  kind: IntentErrorKind;
  message: string;
}

/** Wire envelope: exactly one of success/error is non-null. */
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
