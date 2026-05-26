import { Panel, PanelStatus } from "../components/primitives/Panel";
import { NETWORKS, txExplorerUrl } from "../config/networks";
import { TOKEN_META } from "../config/tokens";
import type { TokenSymbol } from "../config/tokens";
import { fmtAmount, shortHash } from "../lib/format";
import type { Algo, Swap, SwapStatus } from "./lib/types";
import type { Address } from "viem";

const NETWORK = NETWORKS.canary;

const STEP_ORDER: { key: SwapStatus; label: string }[] = [
  { key: "REQUESTED", label: "Swap requested" },
  { key: "AWAITING_DEPOSIT", label: "User transfer" },
  { key: "DEPOSIT_CONFIRMED", label: "Transfer confirmed" },
  { key: "ORDER_PLACED", label: "KalqiX order placed" },
  { key: "FILLED", label: "KalqiX order filled" },
  { key: "PAYOUT_BROADCAST", label: "Payout broadcast" },
  { key: "COMPLETE", label: "Payout confirmed" },
];

function describeStatus(s: SwapStatus): string {
  switch (s) {
    case "REQUESTED": return "Requested";
    case "AWAITING_DEPOSIT": return "Awaiting deposit";
    case "DEPOSIT_CONFIRMED": return "Deposit confirmed";
    case "ORDER_PLACED": return "Order placed";
    case "FILLED": return "Filled";
    case "PAYOUT_BROADCAST": return "Payout sent";
    case "COMPLETE": return "Complete";
    case "FAILED": return "Failed";
  }
}

function panelStatus(s: SwapStatus): { state: "idle" | "live" | "warn" | "ok" | "err"; label: string } {
  if (s === "COMPLETE") return { state: "ok", label: "Settled" };
  if (s === "FAILED") return { state: "err", label: "Failed" };
  return { state: "live", label: "In flight" };
}

function tokenInfoByAddress(addr: Address): { decimals: number; symbol: string } | null {
  const lower = addr.toLowerCase();
  for (const sym of Object.keys(TOKEN_META) as TokenSymbol[]) {
    if (NETWORK.tokens[sym].toLowerCase() === lower) {
      return { decimals: TOKEN_META[sym].decimals, symbol: sym };
    }
  }
  return null;
}

function fmtSignedPct(actual: bigint, baseline: bigint): string | null {
  if (baseline === 0n) return null;
  const bps = ((actual - baseline) * 10000n) / baseline;
  const sign = bps >= 0n ? "+" : "−";
  const abs = bps < 0n ? -bps : bps;
  return `${sign}${(Number(abs) / 100).toFixed(2)}%`;
}

function algoLabel(a: Algo): string {
  if (a === "clear_min") return "A · clear min";
  if (a === "maximize_fill") return "B · market FOK";
  return "C · limit FOK";
}

export function SwapPanel({ swap }: { swap: Swap | null }) {
  if (!swap) {
    return (
      <Panel title="Session" status={<PanelStatus state="idle">Standby</PanelStatus>}>
        <div className="intent__empty">
          <em>no active session.</em>
          configure a swap and click confirm to begin.
        </div>
      </Panel>
    );
  }

  const status = panelStatus(swap.status);
  const inputTok = tokenInfoByAddress(swap.token_in);
  const outputTok = tokenInfoByAddress(swap.token_out);
  const inputDecimals = inputTok?.decimals ?? 18;
  const inputSymbol = inputTok?.symbol ?? "—";
  const outputDecimals = outputTok?.decimals ?? 18;
  const outputSymbol = outputTok?.symbol ?? "—";

  const amountIn = BigInt(swap.amount_in);
  const amountOutMin = BigInt(swap.amount_out_min);
  const amountOutQuote = swap.amount_out_quote
    ? BigInt(swap.amount_out_quote)
    : null;
  const amountActual = swap.fill.net_payout ? BigInt(swap.fill.net_payout) : null;
  // "Input consumed" = the solver's total expenditure to acquire the output.
  // For BUY: filled_quote + taker_fee_paid (both denominated in USDC). Any
  // remainder of amount_in stayed as solver margin (the gap Algo C closes).
  // For SELL: the solver delivered amount_in cbBTC to KalqiX; fee is taken
  // from the USDC received side so the input asset itself is fully consumed.
  const fillFee = swap.fill.taker_fee_paid
    ? BigInt(swap.fill.taker_fee_paid)
    : 0n;
  const filledInputUsed =
    swap.side === "BUY"
      ? swap.fill.filled_quantity_quote
        ? BigInt(swap.fill.filled_quantity_quote) + fillFee
        : null
      : swap.fill.filled_quantity_base
        ? BigInt(swap.fill.filled_quantity_base)
        : null;

  const vsQuote =
    amountActual !== null && amountOutQuote !== null
      ? fmtSignedPct(amountActual, amountOutQuote)
      : null;
  const vsMin =
    amountActual !== null ? fmtSignedPct(amountActual, amountOutMin) : null;
  const inputUsedPct =
    filledInputUsed !== null
      ? fmtSignedPct(filledInputUsed, amountIn)
      : null;

  // Map step records to a fast lookup. Server records the moment of every
  // status transition.
  const stepTimings = new Map<SwapStatus, string>();
  for (const r of swap.steps) {
    if (!stepTimings.has(r.status)) stepTimings.set(r.status, r.at);
  }

  // Filter step list — failure short-circuits the rest.
  const visibleSteps = STEP_ORDER.filter((s) => {
    if (swap.status === "FAILED") {
      // Show only steps the swap actually reached
      return stepTimings.has(s.key);
    }
    return true;
  });

  const isSettled = swap.status === "COMPLETE";
  const isFailed = swap.status === "FAILED";

  return (
    <Panel
      title="Session"
      titleAffix={<span className="panel__head-affix">algo: {algoLabel(swap.algo)}</span>}
      status={<PanelStatus state={status.state}>{status.label}</PanelStatus>}
    >
      <div className="intent">
        <div className="intent__id">
          <span className="label">ID</span>
          <span>{shortHash(swap.id)}</span>
          <span className="deadline">{describeStatus(swap.status)}</span>
        </div>

        <div className="intent__timeline">
          {visibleSteps.map((s) => {
            const reached = stepTimings.has(s.key);
            const cls = reached
              ? "intent__step is-done"
              : "intent__step";
            return (
              <div className={cls} key={s.key}>
                <span className="glyph">{reached ? "●" : "·"}</span>
                <span className="when">
                  {reached ? new Date(stepTimings.get(s.key)!).toLocaleTimeString() : "—"}
                </span>
                <span className="what">{s.label}</span>
                <span className="extra" />
              </div>
            );
          })}
          {isFailed ? (
            <div className="intent__step is-err">
              <span className="glyph">●</span>
              <span className="when">
                {stepTimings.has("FAILED")
                  ? new Date(stepTimings.get("FAILED")!).toLocaleTimeString()
                  : "—"}
              </span>
              <span className="what">{swap.error ?? "Failed"}</span>
              <span className="extra" />
            </div>
          ) : null}
        </div>

        {isSettled || (isFailed && amountActual !== null) ? (
          <div className="exec" style={{ marginTop: 12, borderTop: "1px solid var(--hairline)" }}>
            <div className="exec__row">
              <span className="exec__label">Input</span>
              <span className="exec__value">
                {fmtAmount(amountIn, inputDecimals)} {inputSymbol}
              </span>
            </div>
            {filledInputUsed !== null ? (
              <div className="exec__row">
                <span className="exec__label">Input consumed</span>
                <span className="exec__value">
                  {fmtAmount(filledInputUsed, inputDecimals)} {inputSymbol}
                </span>
              </div>
            ) : null}
            <div className="exec__row">
              <span className="exec__label">Quoted out</span>
              <span className="exec__value">
                {amountOutQuote !== null
                  ? `${fmtAmount(amountOutQuote, outputDecimals)} ${outputSymbol}`
                  : "—"}
              </span>
            </div>
            <div className="exec__row">
              <span className="exec__label">Min out</span>
              <span className="exec__value">
                {fmtAmount(amountOutMin, outputDecimals)} {outputSymbol}
              </span>
            </div>
            <div className="exec__row exec__row--actual">
              <span className="exec__label">Actual out</span>
              <span className="exec__value">
                {amountActual !== null
                  ? `${fmtAmount(amountActual, outputDecimals)} ${outputSymbol}`
                  : "—"}
              </span>
            </div>
            {(vsQuote || vsMin || inputUsedPct) ? (
              <div className="exec__deltas">
                {inputUsedPct ? (
                  <span
                    className={
                      inputUsedPct.startsWith("+") || inputUsedPct === "+0.00%"
                        ? "exec__delta is-better"
                        : "exec__delta is-worse"
                    }
                  >
                    {inputUsedPct} vs input
                  </span>
                ) : null}
                {vsQuote ? (
                  <span
                    className={
                      vsQuote.startsWith("+") || vsQuote === "+0.00%"
                        ? "exec__delta is-better"
                        : "exec__delta is-worse"
                    }
                  >
                    {vsQuote} vs quote
                  </span>
                ) : null}
                {vsMin ? (
                  <span
                    className={
                      vsMin.startsWith("+") || vsMin === "+0.00%"
                        ? "exec__delta is-better"
                        : "exec__delta is-worse"
                    }
                  >
                    {vsMin} vs min
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {(swap.deposit_tx_hash || swap.payout_tx_hash || swap.refund_tx_hash) ? (
          <div className="exec__txlinks" style={{ marginTop: 12, borderTop: "1px solid var(--hairline)" }}>
            {swap.deposit_tx_hash ? (
              <a
                className="exec__txlink"
                href={txExplorerUrl(NETWORK, swap.deposit_tx_hash)}
                target="_blank"
                rel="noopener noreferrer"
              >
                ↗ deposit · {shortHash(swap.deposit_tx_hash)}
              </a>
            ) : null}
            {swap.payout_tx_hash ? (
              <a
                className="exec__txlink"
                href={txExplorerUrl(NETWORK, swap.payout_tx_hash)}
                target="_blank"
                rel="noopener noreferrer"
              >
                ↗ payout · {shortHash(swap.payout_tx_hash)}
              </a>
            ) : null}
            {swap.refund_tx_hash ? (
              <a
                className="exec__txlink"
                href={txExplorerUrl(NETWORK, swap.refund_tx_hash)}
                target="_blank"
                rel="noopener noreferrer"
              >
                ↗ refund · {shortHash(swap.refund_tx_hash)}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
