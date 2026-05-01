import { Panel, PanelStatus } from "./primitives/Panel";
import { useIntentStatus } from "../hooks/useIntent";
import { useIntentTiming } from "../store/intentTiming";
import { useActiveNetwork } from "../hooks/useActiveNetwork";
import { txExplorerUrl } from "../config/networks";
import { shortHash } from "../lib/format";
import type { SettlementState } from "../lib/intent";

interface Row {
  label: string;
  hash: string;
  state: "ok" | "warn" | "live" | "idle" | "err";
  hint?: string;
}

function settlementRows(s: SettlementState): Row[] {
  if (typeof s === "string") return [];
  if ("Settled" in s) {
    const rows: Row[] = [];
    if (s.Settled.approval_tx_hash) {
      rows.push({
        label: "Solver approval",
        hash: s.Settled.approval_tx_hash,
        state: "ok",
        hint: "pre-settlement allowance",
      });
    }
    // Settlement is one atomic on-chain action with two effects. Surface both
    // legs as distinct rows so testers can see the dual-leg semantics; both
    // rows link to the same transaction.
    rows.push({
      label: "Settlement → user",
      hash: s.Settled.settlement_tx_hash,
      state: "ok",
      hint: "output token delivered to user",
    });
    rows.push({
      label: "Settlement → solver",
      hash: s.Settled.settlement_tx_hash,
      state: "ok",
      hint: "escrowed input released to solver",
    });
    return rows;
  }
  if ("Unlocked" in s) {
    return [
      {
        label: "Refund",
        hash: s.Unlocked.tx_hash,
        state: "warn",
        hint: "input asset returned to user",
      },
    ];
  }
  return [];
}

interface Props {
  intentId: string | null;
}

export function TransactionsPanel({ intentId }: Props) {
  const status = useIntentStatus(intentId);
  const lifecycle = useIntentTiming();
  const network = useActiveNetwork();
  const data = status.data;

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
      hint: confirmed
        ? "input locked in escrow"
        : "broadcasting…",
    });
  }

  // Settlement / Refund — once intent has terminal settlement state.
  if (data) {
    rows.push(...settlementRows(data.settlement_state));
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
              {r.hint ? <div className="txlist__hint">{r.hint}</div> : null}
            </a>
          ))}
        </div>
      )}
    </Panel>
  );
}
