import type { Address, Hex } from "viem";
import { shortHash } from "../format";
import {
  isOrderTerminal,
  isSettlementTerminal,
  terminalVerdict,
  type IntentDetail,
  type IntentTerminal,
} from "./types";
import {
  isSettlementTerminalV2,
  isTerminalV2,
  isTradeTerminalV2,
  type IntentDetailV2,
} from "./v2Types";

// ─────────────────────────────────────────────────────────────────────────
// One poller view-model. The legacy GET /intent/{id} shape (mainnet) and the
// v2 GET /v2/intent/{id} shape both normalize into IntentStatusView inside
// the query layer, so the panels are written once and never see raw API
// shapes.
// ─────────────────────────────────────────────────────────────────────────

export type TradePhase =
  | "pending"
  | "ok"
  | "no_match"
  | "expired"
  | "failed"
  | "idle";

export type SettlementPhase =
  | "pending"
  | "settled"
  | "unlocked"
  | "failed"
  | "idle";

export interface IntentStatusView {
  id: string;
  input: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: string;
    amountOutMin: string;
    amountOutQuote: string | null;
  };
  trade: {
    phase: TradePhase;
    /** Pill copy, e.g. "Success", "No match found", "Failed · reason". */
    text: string;
    /** Detail string for the recorded lifecycle step. */
    detail: string;
    amountOut: string | null;
    /** Server-provided output metadata (v1 only; v2 uses the local token
     *  registry instead). */
    amountOutDecimals: number | null;
    amountOutSymbol: string | null;
  };
  settlement: {
    phase: SettlementPhase;
    text: string;
    amount: string | null;
    txHash: Hex | null;
    approvalTxHash: Hex | null;
  };
  isTradeTerminal: boolean;
  isSettlementTerminal: boolean;
  /** Polling stops here. v1: both legs terminal. v2: overall outcome decided
   *  (or expired with nothing initiated). */
  isTerminal: boolean;
  terminal: IntentTerminal;
  /** Prepared terminal lifecycle step ("settled" row + lifecycle.end()).
   *  Non-null once the swap's end state is known — including the v2 edge
   *  where the intent dies without settlement ever initiating. */
  endStep: { label: string; detail: string; ok: boolean; tx?: Hex } | null;
}

export function viewFromV1(d: IntentDetail): IntentStatusView {
  const o = d.order;
  const s = d.settlement;

  const tradePhase: TradePhase =
    o.status === "SUCCESS"
      ? "ok"
      : o.status === "FAILED"
        ? "failed"
        : o.status === "PENDING"
          ? "pending"
          : "idle";
  const tradeText =
    o.status === "FAILED"
      ? o.error_message
        ? `Failed · ${o.error_message}`
        : "Failed"
      : o.status === "SUCCESS"
        ? "Success"
        : o.status === "PENDING"
          ? "Pending"
          : "Unknown";

  const settlementPhase: SettlementPhase =
    s.status === "SETTLED"
      ? "settled"
      : s.status === "UNLOCKED"
        ? "unlocked"
        : s.status === "FAILED_TO_SETTLE" || s.status === "FAILED_TO_UNLOCK"
          ? "failed"
          : s.status === "PENDING"
            ? "pending"
            : "idle";
  let settlementText = "Unknown";
  if (s.status === "SETTLED") {
    settlementText = s.tx_hash ? `Settled · ${shortHash(s.tx_hash)}` : "Settled";
  } else if (s.status === "UNLOCKED") {
    settlementText = s.tx_hash
      ? `Unlocked · ${shortHash(s.tx_hash)}`
      : "Unlocked";
  } else if (s.status === "FAILED_TO_SETTLE") {
    settlementText = s.error_message
      ? `Failed to settle · ${s.error_message}`
      : "Failed to settle";
  } else if (s.status === "FAILED_TO_UNLOCK") {
    settlementText = s.error_message
      ? `Failed to unlock · ${s.error_message}`
      : "Failed to unlock";
  } else if (s.status === "PENDING") {
    settlementText = "Pending";
  }

  // Lifecycle end-step: same wording the panel used pre-migration.
  let endStep: IntentStatusView["endStep"] = null;
  if (isSettlementTerminal(s)) {
    if (s.status === "SETTLED") {
      endStep = {
        label: "User filled (IntentSettled)",
        detail: "",
        ok: true,
        tx: s.tx_hash ?? undefined,
      };
    } else if (s.status === "UNLOCKED") {
      endStep = {
        label: "User refunded (IntentUnlocked)",
        detail: "",
        ok: false,
        tx: s.tx_hash ?? undefined,
      };
    } else if (s.status === "FAILED_TO_SETTLE") {
      endStep = {
        label: "Settlement failed",
        detail: s.error_message ?? "FAILED_TO_SETTLE",
        ok: false,
      };
    } else {
      endStep = {
        label: "Unlock failed",
        detail: s.error_message ?? "FAILED_TO_UNLOCK",
        ok: false,
      };
    }
  }

  return {
    id: d.intent_id,
    input: {
      tokenIn: d.input.token_in,
      tokenOut: d.input.token_out,
      amountIn: d.input.amount_in,
      amountOutMin: d.input.amount_out,
      amountOutQuote: d.input.amount_out_quote,
    },
    trade: {
      phase: tradePhase,
      text: tradeText,
      detail:
        o.status === "FAILED"
          ? o.error_message ?? "FAILED"
          : o.amount_out_symbol ?? "",
      amountOut: o.amount_out,
      amountOutDecimals: o.amount_out_decimals,
      amountOutSymbol: o.amount_out_symbol,
    },
    settlement: {
      phase: settlementPhase,
      text: settlementText,
      amount: s.amount_out,
      txHash: s.tx_hash,
      approvalTxHash: s.approval_tx_hash,
    },
    isTradeTerminal: isOrderTerminal(o),
    isSettlementTerminal: isSettlementTerminal(s),
    isTerminal: isOrderTerminal(o) && isSettlementTerminal(s),
    terminal: terminalVerdict(d),
    endStep,
  };
}

export function viewFromV2(d: IntentDetailV2): IntentStatusView {
  const t = d.trade_outcome;
  const s = d.settlement_outcome;
  const td = d.trade_details;
  const sd = d.settlement_details;
  const terminal = isTerminalV2(d);

  const tradePhase: TradePhase =
    t === "SUCCESS"
      ? "ok"
      : t === "NO_MATCH_FOUND"
        ? "no_match"
        : t === "TTL_EXPIRED"
          ? "expired"
          : t === "FAILURE"
            ? "failed"
            : t === "PENDING"
              ? "pending"
              : "idle";
  const tradeText =
    t === "SUCCESS"
      ? "Success"
      : t === "NO_MATCH_FOUND"
        ? "No match found"
        : t === "TTL_EXPIRED"
          ? "Order TTL expired"
          : t === "FAILURE"
            ? td.error_message
              ? `Failed · ${td.error_message}`
              : "Failed"
            : t === "PENDING"
              ? "Pending"
              : "Not initiated";
  const tradeDetail =
    t === "FAILURE"
      ? td.error_message ?? "FAILURE"
      : t === "NO_MATCH_FOUND"
        ? "No match found"
        : t === "TTL_EXPIRED"
          ? "Order TTL expired"
          : "";

  const settlementPhase: SettlementPhase =
    s === "FUNDS_SETTLED"
      ? "settled"
      : s === "FUNDS_UNLOCKED"
        ? "unlocked"
        : s === "FAILURE"
          ? "failed"
          : s === "PENDING"
            ? "pending"
            : "idle";
  // v2 doesn't split settle-vs-unlock failure into distinct enums — the
  // attempted action lives in settlement_details.action.
  const failVerb = sd.action === "UNLOCK" ? "unlock" : "settle";
  const settlementText =
    s === "FUNDS_SETTLED"
      ? sd.tx_hash
        ? `Settled · ${shortHash(sd.tx_hash)}`
        : "Settled"
      : s === "FUNDS_UNLOCKED"
        ? sd.tx_hash
          ? `Unlocked · ${shortHash(sd.tx_hash)}`
          : "Unlocked"
        : s === "FAILURE"
          ? sd.error_message
            ? `Failed to ${failVerb} · ${sd.error_message}`
            : `Failed to ${failVerb}`
          : s === "PENDING"
            ? "Pending"
            : "Not initiated";

  let endStep: IntentStatusView["endStep"] = null;
  if (s === "FUNDS_SETTLED") {
    endStep = {
      label: "User filled (IntentSettled)",
      detail: "",
      ok: true,
      tx: sd.tx_hash ?? undefined,
    };
  } else if (s === "FUNDS_UNLOCKED") {
    endStep = {
      label: "User refunded (IntentUnlocked)",
      detail: "",
      ok: false,
      tx: sd.tx_hash ?? undefined,
    };
  } else if (s === "FAILURE") {
    endStep = {
      label: sd.action === "UNLOCK" ? "Unlock failed" : "Settlement failed",
      detail: sd.error_message ?? "FAILURE",
      ok: false,
    };
  } else if (terminal) {
    // Intent died without settlement ever initiating (order failed / no
    // match / TTL or intent expiry) — still an end state for the lifecycle.
    endStep = {
      label:
        t === "TTL_EXPIRED" || (d.expired && t === "NOT_INITIATED")
          ? "Intent expired before execution"
          : "Order failed",
      detail: tradeDetail || (d.expired ? "Intent expired" : d.outcome),
      ok: false,
    };
  }

  let verdict: IntentTerminal = null;
  if (s === "FUNDS_SETTLED") {
    verdict = {
      kind: "settled",
      settlementTx: sd.tx_hash ?? ("0x" as Hex),
      approvalTx: sd.approval_tx_hash,
    };
  } else if (s === "FUNDS_UNLOCKED") {
    verdict = { kind: "unlocked", tx: sd.tx_hash };
  } else if (s === "FAILURE") {
    verdict = {
      kind: "failed",
      where: "settlement",
      reason: sd.error_message ?? "FAILURE",
    };
  } else if (terminal) {
    verdict = {
      kind: "failed",
      where: "order",
      reason:
        td.error_message ??
        (t === "NO_MATCH_FOUND" || t === "TTL_EXPIRED"
          ? tradeDetail
          : d.expired
            ? "Intent expired"
            : d.outcome),
    };
  }

  return {
    id: d.id,
    input: {
      tokenIn: d.input.token_in,
      tokenOut: d.input.token_out,
      amountIn: d.input.amount_in,
      amountOutMin: d.input.amount_out,
      amountOutQuote: d.input.amount_out_quote,
    },
    trade: {
      phase: tradePhase,
      text: tradeText,
      detail: tradeDetail,
      amountOut: td.order_amount,
      amountOutDecimals: null,
      amountOutSymbol: null,
    },
    settlement: {
      phase: settlementPhase,
      text: settlementText,
      amount: sd.amount,
      txHash: sd.tx_hash,
      approvalTxHash: sd.approval_tx_hash,
    },
    isTradeTerminal: isTradeTerminalV2(t),
    isSettlementTerminal: isSettlementTerminalV2(s),
    isTerminal: terminal,
    terminal: verdict,
    endStep,
  };
}
