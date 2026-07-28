import { Panel, PanelStatus } from "./primitives/Panel";
import { useIntentStatus } from "../hooks/useIntent";
import { useCurrentLifecycle } from "../hooks/useCurrentLifecycle";
import { useActiveNetwork } from "../hooks/useActiveNetwork";
import { txExplorerUrl, type NetworkConfig } from "../config/networks";
import { TOKEN_META, getToken } from "../config/tokens";
import type { TokenInfo, TokenSymbol } from "../config/tokens";
import { fmtAmount, shortHash } from "../lib/format";
import type { IntentStatusView } from "../lib/intent";
import type { Address } from "viem";

interface Row {
  label: string;
  hash: string;
  state: "ok" | "warn" | "live" | "idle" | "err";
  hint?: string | string[];
}

function settlementRows(s: IntentStatusView["settlement"]): Row[] {
  if (s.phase === "settled") {
    const rows: Row[] = [];
    if (s.approvalTxHash) {
      rows.push({
        label: "Solver approval",
        hash: s.approvalTxHash,
        state: "ok",
        hint: "pre-settlement allowance",
      });
    }
    if (s.txHash) {
      // Settlement is one atomic on-chain action with two effects — surface
      // both as a two-line hint under a single row.
      rows.push({
        label: "Settlement",
        hash: s.txHash,
        state: "ok",
        hint: [
          "output token delivered to user",
          "escrowed input released to solver",
        ],
      });
    }
    return rows;
  }
  if (s.phase === "unlocked" && s.txHash) {
    return [
      {
        label: "Refund",
        hash: s.txHash,
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
 *  settlement lands cleanly — the input, the quoted-out we sent, the on-chain
 *  min floor, and what was actually delivered. The delta vs quote is the
 *  price-execution signal a tester cares about. */
function ExecutionView({
  view,
  network,
  depositTxHash,
  kyberAmountOut,
}: {
  view: IntentStatusView;
  network: NetworkConfig;
  depositTxHash: string | null;
  kyberAmountOut: string | null;
}) {
  const inputTok = tokenInfoByAddress(network, view.input.tokenIn);
  const outputTok = tokenInfoByAddress(network, view.input.tokenOut);

  const inputDecimals = inputTok?.decimals ?? 18;
  const inputSymbol = inputTok?.symbol ?? "—";

  // Output: prefer server-provided decimals/symbol (v1 poller only); the v2
  // shape has none, so fall back to the local token registry — total for the
  // harness's USDC/cbBTC/ETH set.
  const outputDecimals =
    view.trade.amountOutDecimals ?? outputTok?.decimals ?? 18;
  const outputSymbol = view.trade.amountOutSymbol ?? outputTok?.symbol ?? "—";

  const amountIn = BigInt(view.input.amountIn);
  const amountOutMin = BigInt(view.input.amountOutMin);
  const amountOutQuote = view.input.amountOutQuote
    ? BigInt(view.input.amountOutQuote)
    : null;
  // Prefer the settlement amount (what the contract recorded as delivered).
  // Fall back to the trade amount if settlement is missing it.
  const amountActual = view.settlement.amount
    ? BigInt(view.settlement.amount)
    : view.trade.amountOut
      ? BigInt(view.trade.amountOut)
      : null;

  const kyberOut = kyberAmountOut ? BigInt(kyberAmountOut) : null;

  const vsMin =
    amountActual !== null ? fmtSignedPct(amountActual, amountOutMin) : null;
  const vsQuote =
    amountActual !== null && amountOutQuote !== null
      ? fmtSignedPct(amountActual, amountOutQuote)
      : null;
  const vsKyber =
    amountActual !== null && kyberOut !== null && kyberOut > 0n
      ? fmtSignedPct(amountActual, kyberOut)
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
      {kyberOut !== null ? (
        <div className="exec__row">
          <span className="exec__label">Kyberswap est.</span>
          <span className="exec__value">
            {fmtAmount(kyberOut, outputDecimals)} {outputSymbol}
          </span>
        </div>
      ) : null}
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
      {vsMin || vsQuote || vsKyber ? (
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
          {vsKyber ? (
            <span
              className={
                vsKyber.startsWith("+")
                  ? "exec__delta is-better"
                  : "exec__delta is-worse"
              }
            >
              {vsKyber} vs Kyber
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
      {(depositTxHash || view.settlement.txHash) ? (
        <div className="exec__txlinks">
          {depositTxHash ? (
            <a
              className="exec__txlink"
              href={txExplorerUrl(network, depositTxHash)}
              target="_blank"
              rel="noopener noreferrer"
            >
              ↗ deposit · {shortHash(depositTxHash)}
            </a>
          ) : null}
          {view.settlement.txHash ? (
            <a
              className="exec__txlink"
              href={txExplorerUrl(network, view.settlement.txHash)}
              target="_blank"
              rel="noopener noreferrer"
            >
              ↗ settlement · {shortHash(view.settlement.txHash)}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function TransactionsPanel() {
  const lifecycle = useCurrentLifecycle();
  const isKyber = lifecycle.venue === "KYBERSWAP";
  // KYBERSWAP swaps have no backend lifecycle — never poll for them.
  const status = useIntentStatus(isKyber ? null : lifecycle.intentId);
  const network = useActiveNetwork();
  const data = status.data;

  // Deposit tx hash lives in the lifecycle store — recorded by SwapForm as
  // soon as the deposit broadcasts. Used by both views.
  const depositTxHash =
    lifecycle.steps.find(
      (s) => s.key === "deposit" || s.key === "deposited"
    )?.tx ?? null;

  // Repurpose the panel to a price-execution view once the swap has settled
  // cleanly. Refund and failure terminal states keep the original tx-row view.
  if (data && data.settlement.phase === "settled") {
    return (
      <Panel
        title="Execution"
        status={<PanelStatus state="ok">Settled</PanelStatus>}
      >
        <ExecutionView
          view={data}
          network={network}
          depositTxHash={depositTxHash}
          kyberAmountOut={lifecycle.kyberAmountOut}
        />
      </Panel>
    );
  }

  const rows: Row[] = [];

  // Deposit (user) — known as soon as deposit broadcasts. KALQIX only.
  if (depositTxHash) {
    const confirmed = lifecycle.steps.some((s) => s.key === "deposited");
    rows.push({
      label: "Deposit",
      hash: depositTxHash,
      state: confirmed ? "ok" : "live",
      hint: confirmed ? "input locked in escrow" : "broadcasting…",
    });
  }

  // KYBERSWAP: the router tx is the whole swap — one row, receipt-terminal.
  const routerTxHash =
    lifecycle.steps.find(
      (s) => s.key === "routerTx" || s.key === "routerConfirmed"
    )?.tx ?? null;
  if (routerTxHash) {
    const confirmedStep = lifecycle.steps.find(
      (s) => s.key === "routerConfirmed"
    );
    rows.push({
      label: "Router swap",
      hash: routerTxHash,
      state: confirmedStep ? (confirmedStep.ok ? "ok" : "err") : "live",
      hint: confirmedStep
        ? confirmedStep.ok
          ? lifecycle.actualAmountOut
            ? `received ${lifecycle.actualAmountOut}`
            : "confirmed"
          : "reverted"
        : "broadcasting…",
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
