import type { Address, Hex } from "viem";

// ─────────────────────────────────────────────────────────────────────────
// GET /v2/intent/{id} — KALQIX intents only. KYBERSWAP swaps have no backend
// lifecycle; their terminal state is the router tx receipt.
// ─────────────────────────────────────────────────────────────────────────

export type IntentOutcomeV2 = "SUCCESS" | "FAILURE" | "NOT_DETERMINED";

export type TradeOutcome =
  | "SUCCESS"
  | "NO_MATCH_FOUND"
  | "TTL_EXPIRED"
  | "FAILURE"
  | "PENDING"
  | "NOT_INITIATED";

export type SettlementOutcomeV2 =
  | "FUNDS_SETTLED"
  | "FUNDS_UNLOCKED"
  | "FAILURE"
  | "PENDING"
  | "NOT_INITIATED";

export interface IntentInputV2 {
  client_id: string | null;
  token_in: Address;
  token_out: Address;
  amount_in: string;
  amount_out: string;
  amount_out_quote: string | null;
}

/** Timestamps here are DB strings, not unix ms. */
export interface TradeDetails {
  error_code: string | null;
  error_message: string | null;
  order_id: string | null;
  order_status: string | null;
  order_amount: string | null;
  created_at: string | null;
  finished_at: string | null;
}

export interface SettlementDetails {
  error_code: string | null;
  error_message: string | null;
  action: "SETTLE" | "UNLOCK" | null;
  amount: string | null;
  tx_hash: Hex | null;
  approval_tx_hash: Hex | null;
  created_at: string | null;
  finished_at: string | null;
}

export interface IntentDetailV2 {
  id: string;
  venue: "KALQIX";
  input: IntentInputV2;
  expired: boolean;
  outcome: IntentOutcomeV2;
  trade_outcome: TradeOutcome;
  settlement_outcome: SettlementOutcomeV2;
  trade_details: TradeDetails;
  settlement_details: SettlementDetails;
}

export function isTradeTerminalV2(t: TradeOutcome): boolean {
  return t !== "PENDING" && t !== "NOT_INITIATED";
}

export function isSettlementTerminalV2(s: SettlementOutcomeV2): boolean {
  return s !== "PENDING" && s !== "NOT_INITIATED";
}

/** Terminal when the overall outcome is decided, or the intent expired
 *  without either leg ever starting. */
export function isTerminalV2(d: IntentDetailV2): boolean {
  if (d.outcome !== "NOT_DETERMINED") return true;
  return (
    d.expired &&
    d.trade_outcome === "NOT_INITIATED" &&
    d.settlement_outcome === "NOT_INITIATED"
  );
}
