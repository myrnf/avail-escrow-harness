import type { Address, Hex } from "viem";

export interface CreateIntentRequest {
  token_in: Address;
  token_out: Address;
  amount_in: string;
  amount_out: string;
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
  | "INITIAL_VALIDATION"
  | "VALIDATION"
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

/* ---------- GET /intent/{id} ---------- */

export type OrderState =
  | "None"
  | "Pending"
  | { Completed: "Filled" | "Expired" | "Cancelled" | "PartiallyFilled" | string }
  | { Rejected: string }
  | { Failed: string };

export type SettlementState =
  | "None"
  | "Pending"
  | {
      Settled: {
        settlement_tx_hash: Hex;
        approval_tx_hash: Hex | null;
      };
    }
  | { Unlocked: { tx_hash: Hex } }
  | { Rejected: string }
  | { Failed: string };

export interface IntentDetail {
  intent_id: string;
  client_intent_id: string | null;
  token_in: Address;
  token_out: Address;
  amount_in: string;
  amount_out: string;
  permit: string | null;
  order_state: OrderState;
  settlement_state: SettlementState;
}

/* ---------- helpers ---------- */

export function isOrderTerminal(s: OrderState): boolean {
  if (typeof s === "string") return false;
  return "Completed" in s || "Rejected" in s || "Failed" in s;
}

export function isSettlementTerminal(s: SettlementState): boolean {
  if (typeof s === "string") return false;
  return "Settled" in s || "Unlocked" in s || "Rejected" in s || "Failed" in s;
}

export type IntentTerminal =
  | { kind: "settled"; settlementTx: Hex; approvalTx: Hex | null }
  | { kind: "unlocked"; tx: Hex }
  | { kind: "rejected"; where: "order" | "settlement"; reason: string }
  | { kind: "failed"; where: "order" | "settlement"; reason: string }
  | null;

/** Returns a single normalized terminal verdict, or null if still in flight. */
export function terminalVerdict(d: IntentDetail): IntentTerminal {
  const o = d.order_state;
  const s = d.settlement_state;

  if (typeof s === "object") {
    if ("Settled" in s) {
      return {
        kind: "settled",
        settlementTx: s.Settled.settlement_tx_hash,
        approvalTx: s.Settled.approval_tx_hash,
      };
    }
    if ("Unlocked" in s) {
      return { kind: "unlocked", tx: s.Unlocked.tx_hash };
    }
    if ("Rejected" in s) {
      return { kind: "rejected", where: "settlement", reason: s.Rejected };
    }
    if ("Failed" in s) {
      return { kind: "failed", where: "settlement", reason: s.Failed };
    }
  }

  if (typeof o === "object") {
    if ("Rejected" in o) {
      return { kind: "rejected", where: "order", reason: o.Rejected };
    }
    if ("Failed" in o) {
      return { kind: "failed", where: "order", reason: o.Failed };
    }
  }

  return null;
}
