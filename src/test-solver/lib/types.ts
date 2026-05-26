import type { Address, Hex } from "viem";

export type Algo = "clear_min" | "maximize_fill" | "max_fill_limit";
export type Side = "BUY" | "SELL";

/** Mirrors backend SwapStatus in src/state.rs. */
export type SwapStatus =
  | "REQUESTED"
  | "AWAITING_DEPOSIT"
  | "DEPOSIT_CONFIRMED"
  | "ORDER_PLACED"
  | "FILLED"
  | "PAYOUT_BROADCAST"
  | "COMPLETE"
  | "FAILED";

export interface StepRecord {
  at: string; // ISO-8601
  status: SwapStatus;
  note: string | null;
}

export interface FillData {
  order_id: string | null;
  filled_quantity_base: string | null;
  filled_quantity_quote: string | null;
  average_price: string | null;
  taker_fee_paid: string | null;
  net_payout: string | null;
}

export interface Swap {
  id: string;
  user_eoa: Address;
  algo: Algo;
  side: Side;

  token_in: Address;
  token_out: Address;
  amount_in: string;
  amount_out_min: string;
  amount_out_quote: string | null;

  recipient_eoa: Address;
  created_at: string;
  expires_at: string;

  status: SwapStatus;
  steps: StepRecord[];
  deposit_tx_hash: Hex | null;
  payout_tx_hash: Hex | null;
  refund_tx_hash: Hex | null;
  fill: FillData;
  error: string | null;
}

export interface SwapRequestBody {
  token_in: Address;
  token_out: Address;
  amount_in: string;
  amount_out_min: string;
  amount_out_quote?: string | null;
  algo: Algo;
  user_eoa: Address;
}

export interface SwapRequestResponse {
  swap_id: string;
  recipient_eoa: Address;
  expires_at: string;
}

export function isTerminal(s: SwapStatus): boolean {
  return s === "COMPLETE" || s === "FAILED";
}
