import { Panel, PanelStatus } from "./primitives/Panel";
import { useIntentStatus } from "../hooks/useIntent";
import { useCurrentLifecycle } from "../hooks/useCurrentLifecycle";
import { useActiveNetwork } from "../hooks/useActiveNetwork";
import { txExplorerUrl, type NetworkConfig } from "../config/networks";
import { TOKEN_META, getToken } from "../config/tokens";
import type { TokenInfo, TokenSymbol } from "../config/tokens";
import { fmtAmount, shortHash } from "../lib/format";
import type { IntentDetail, SettlementOutcome } from "../lib/intent";
import type { Address } from "viem";

interface Row {
  label: string;
  hash: string;
  state: "ok" | "warn" | "live" | "idle" | "err";
  hint?: string | string[];
}

function settlementRows(s: SettlementOutcome): Row[] {
  if (s.status === "SETTLED") {
    const rows: Row[] = [];
    if (s.approval_tx_hash) {
      rows.push({
        label: "Solver approval",
        hash: s.approval_tx_hash,
        state: "ok",
        hint: "pre-settlement allowance",
      });
    }
    if (s.tx_hash) {
      // Settlement is one atomic on-chain action with two effects — surface
      // both as a two-line hint under a single row.
      rows.push({
        label: "Settlement",
        hash: s.tx_hash,
        state: "ok",
        hint: [
          "output token delivered to user",
          "escrowed input released to solver",
        ],
      });
    }
    return rows;
  }
  if (s.status === "UNLOCKED" && s.tx_hash) {
    return [
      {
        label: "Refund",
        hash: s.tx_hash,
        state: "warn",
        hint: "input asset returned to user",
      },
    ];
  }
  return [];
}

/** Local lookup: TokenInfo for an address on the active network, or null
 *  if the address isn't a known harness token. */
function tokenInfoByAddress(
  network: NetworkConfig,
  addr: Address
): TokenInfo | null {
  const lower = addr.toLowerCase();
  for (const sym of Object.keys(TOKEN_META) as TokenSymbol[]) {
    if (network.tokens[sym].toLowerCase() === lower) {
      return getToken(network, sym);
    }
  }
  return null;
}

/** Render (actual - baseline) / baseline as a signed percentage string. */
function fmtSignedPct(actual: bigint, baseline: bigint): string {
  if (baseline === 0n) return "—";
  const bps = ((actual - baseline) * 10000n) / baseline;
  const sign = bps >= 0n ? "+" : "−";
  const abs = bps < 0n ? -bps : bps;
  return `${sign}${(Number(abs) / 100).toFixed(2)}%`;
}

/** Post-settlement execution-quality view. Replaces the tx-row list when
 *  settlement.status === "SETTLED" — the input, the quoted-out we sent, the
 *  on-chain min floor, and what was actually delivered. The delta vs quote is
 *  the price-execution signal a tester cares about. */
function ExecutionView({
  data,
  network,
}: {
  data: IntentDetail;
  network: NetworkConfig;
}) {
  const inputTok = tokenInfoByAddress(network, data.input.token_in);
  const outputTok = tokenInfoByAddress(network, data.input.token_out);

  const inputDecimals = inputTok?.decimals ?? 18;
  const inputSymbol = inputTok?.symbol ?? "—";

  // Output: prefer server-provided decimals/symbol from order outcome; fall
  // back to local TokenInfo for the input symbol/decimals.
  const outputDecimals =
    data.order.amount_out_decimals ?? outputTok?.decimals ?? 18;
  const outputSymbol =
    data.order.amount_out_symbol ?? outputTok?.symbol ?? "—";

  const amountIn = BigInt(data.input.amount_in);
  const amountOutMin = BigInt(data.input.amount_out);
  const amountOutQuote = data.input.amount_out_quote
    ? BigInt(data.input.amount_out_quote)
    : null;
  // Prefer settlement.amount_out (what the contract recorded as delivered).
  // Fall back to order.amount_out if for some reason settlement is missing it.
  const amountActual = data.settlement.amount_out
    ? BigInt(data.settlement.amount_out)
    : data.order.amount_out
      ? BigInt(data.order.amount_out)
      : null;

  const vsMin =
    amountActual !== null
      ? fmtSignedPct(amountActual, amountOutMin)
      : null;
  const vsQuote =
    amountActual !== null && amountOutQuote !== null
      ? fmtSignedPct(amountActual, amountOutQuote)
      : null;

  return (
    <div className="exec">
      <div className="exec__row">
        <span className="exec__label">Input</span>
        <span className="exec__value">
          {fmtAmount(amountIn, inputDecimals)} {inputSymbol}
        </span>
      </div>
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
      {vsMin || vsQuote ? (
        <div className="exec__deltas">
          {vsQuote ? (
            <span
              className={
                vsQuote.startsWith("+")
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
                vsMin.startsWith("+")
                  ? "exec__delta is-better"
                  : "exec__delta is-worse"
              }
            >
              {vsMin} vs min
            </span>
          ) : null}
        </div>
      ) : null}
      {data.settlement.tx_hash ? (
        <a
          className="exec__txlink"
          href={txExplorerUrl(network, data.settlement.tx_hash)}
          target="_blank"
          rel="noopener noreferrer"
        >
          ↗ settlement · {shortHash(data.settlement.tx_hash)}
        </a>
      ) : null}
    </div>
  );
}

export function TransactionsPanel() {
  const lifecycle = useCurrentLifecycle();
  const status = useIntentStatus(lifecycle.intentId);
  const network = useActiveNetwork();
  const data = status.data;

  // Repurpose the panel to a price-execution view once the swap has settled
  // cleanly. Refund and failure terminal states keep the original tx-row view.
  if (data && data.settlement.status === "SETTLED") {
    return (
      <Panel
        title="Execution"
        status={<PanelStatus state="ok">Settled</PanelStatus>}
      >
        <ExecutionView data={data} network={network} />
      </Panel>
    );
  }

  const rows: Row[] = [];

  // Deposit (user) — known as soon as deposit broadcasts.
  const depositStep = lifecycle.steps.find(
    (s) => s.key === "deposit" || s.key === "deposited"
  );
  if (depositStep?.tx) {
    const confirmed = lifecycle.steps.some((s) => s.key === "deposited");
    rows.push({
      label: "Deposit",
      hash: depositStep.tx,
      state: confirmed ? "ok" : "live",
      hint: confirmed ? "input locked in escrow" : "broadcasting…",
    });
  }

  // Settlement / Refund — once intent has terminal settlement state.
  if (data) {
    rows.push(...settlementRows(data.settlement));
  }

  const empty = rows.length === 0;

  return (
    <Panel
      title="Transactions"
      status={
        empty ? (
          <PanelStatus state="idle">Standby</PanelStatus>
        ) : (
          <PanelStatus state="live">{rows.length}</PanelStatus>
        )
      }
    >
      {empty ? (
        <div className="intent__empty">
          <em>no transactions yet.</em>
          deposit, settlement, and refund tx links appear here.
        </div>
      ) : (
        <div className="txlist">
          {rows.map((r, i) => (
            <a
              key={i}
              className="txlist__row"
              href={txExplorerUrl(network, r.hash)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <div className="txlist__top">
                <span className={`txlist__label state-${r.state}`}>
                  <span className={`dot is-${r.state}`} />
                  {r.label}
                </span>
                <span className="txlist__hash">{shortHash(r.hash)}</span>
              </div>
              {r.hint ? (
                <div className="txlist__hint">
                  {(Array.isArray(r.hint) ? r.hint : [r.hint]).map((line, j) => (
                    <div key={j}>{line}</div>
                  ))}
                </div>
              ) : null}
            </a>
          ))}
        </div>
      )}
    </Panel>
  );
}
