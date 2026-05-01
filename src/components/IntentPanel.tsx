import { useEffect, useMemo, useState } from "react";
import { Panel, PanelStatus, Dot } from "./primitives/Panel";
import { useIntentStatus } from "../hooks/useIntent";
import {
  isOrderTerminal,
  isSettlementTerminal,
  terminalVerdict,
  type OrderState,
  type SettlementState,
} from "../lib/intent";
import { shortHash } from "../lib/format";
import { useActivityLog } from "../store/activityLog";
import { type StepKey, type TimingStep } from "../store/intentTiming";
import { useCurrentLifecycle } from "../hooks/useCurrentLifecycle";


// "submit" is the timeline anchor used to compute the first phase duration —
// not rendered as its own row (it's always 0ms, so not informative).
// "deposit" (broadcast) is still recorded in the lifecycle so the Transactions
// panel can show the tx hash the moment MetaMask returns, but it's collapsed
// into the "deposit confirmed" row in this timeline — duration on that row is
// the full sign-and-mine wall time.
const STEP_ORDER: { key: StepKey; label: string }[] = [
  { key: "createIntent", label: "POST /intent" },
  { key: "deposited", label: "User deposited (IntentDeposited)" },
  { key: "fill", label: "KalqiX fill" },
  // Default to the happy-path label; if the swap unwinds, the recorded step
  // overrides this with "User refunded (IntentUnlocked)" at settlement time.
  { key: "settled", label: "User filled (IntentSettled)" },
];

const RENDERED_KEYS = new Set<StepKey>(STEP_ORDER.map((s) => s.key));

function describeOrderState(s: OrderState): string {
  if (typeof s === "string") return s;
  if ("Completed" in s) return `Completed: ${s.Completed}`;
  if ("Rejected" in s) return `Rejected · ${s.Rejected}`;
  if ("Failed" in s) return `Failed · ${s.Failed}`;
  return "Unknown";
}
function describeSettlementState(s: SettlementState): string {
  if (typeof s === "string") return s;
  if ("Settled" in s)
    return `Settled · ${shortHash(s.Settled.settlement_tx_hash)}`;
  if ("Unlocked" in s) return `Unlocked · ${shortHash(s.Unlocked.tx_hash)}`;
  if ("Rejected" in s) return `Rejected · ${s.Rejected}`;
  if ("Failed" in s) return `Failed · ${s.Failed}`;
  return "Unknown";
}

function pillState(
  s: OrderState | SettlementState,
  isOrderField: boolean
): { cls: string; dot: "idle" | "live" | "warn" | "ok" | "err" } {
  if (typeof s === "string") {
    if (s === "Pending") return { cls: "is-pending", dot: "live" };
    return { cls: "", dot: "idle" };
  }
  if (isOrderField && "Completed" in s && s.Completed === "Filled") {
    return { cls: "is-ok", dot: "ok" };
  }
  if (!isOrderField && "Settled" in s) return { cls: "is-ok", dot: "ok" };
  if (!isOrderField && "Unlocked" in s) return { cls: "is-err", dot: "warn" };
  if ("Rejected" in s || "Failed" in s) return { cls: "is-err", dot: "err" };
  return { cls: "", dot: "idle" };
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function IntentPanel() {
  const lifecycle = useCurrentLifecycle();
  const intentId = lifecycle.intentId;
  const status = useIntentStatus(intentId);
  const data = status.data;
  const log = useActivityLog((s) => s.push);

  // Live elapsed counter — re-renders every 250ms while in flight.
  const [, force] = useState(0);
  useEffect(() => {
    if (lifecycle.endedAt !== null || lifecycle.steps.length === 0) return;
    const id = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [lifecycle.endedAt, lifecycle.steps.length]);

  // ---------- LIFECYCLE: detect order_state terminal ----------
  const orderTerminal = data ? isOrderTerminal(data.order_state) : false;
  useEffect(() => {
    if (!data || !orderTerminal) return;
    const o = data.order_state;
    let detail = "";
    let ok = true;
    if (typeof o === "object") {
      if ("Completed" in o) {
        detail = o.Completed;
        ok = o.Completed === "Filled";
      } else if ("Rejected" in o) {
        detail = o.Rejected;
        ok = false;
      } else if ("Failed" in o) {
        detail = o.Failed;
        ok = false;
      }
    }
    lifecycle.recordStep({
      key: "fill",
      at: Date.now(),
      label: "KalqiX fill",
      ok,
      detail,
    });
  }, [orderTerminal]);

  // ---------- LIFECYCLE: detect settlement_state terminal ----------
  const settlementTerminal = data
    ? isSettlementTerminal(data.settlement_state)
    : false;
  useEffect(() => {
    if (!data || !settlementTerminal) return;
    const s = data.settlement_state;
    let label = "Settlement";
    let detail = "";
    let ok = true;
    let tx: string | undefined;
    if (typeof s === "object") {
      if ("Settled" in s) {
        label = "User filled (IntentSettled)";
        tx = s.Settled.settlement_tx_hash;
      } else if ("Unlocked" in s) {
        label = "User refunded (IntentUnlocked)";
        tx = s.Unlocked.tx_hash;
        ok = false;
      } else if ("Rejected" in s) {
        detail = s.Rejected;
        ok = false;
      } else if ("Failed" in s) {
        detail = s.Failed;
        ok = false;
      }
    }
    lifecycle.recordStep({
      key: "settled",
      at: Date.now(),
      label,
      ok,
      detail,
      tx,
    });
    lifecycle.end(Date.now());

    // Activity log
    const verdict = terminalVerdict(data);
    if (verdict?.kind === "settled") {
      log({
        level: "ok",
        channel: "EVT",
        message: `IntentSettled · ${data.intent_id}`,
        details: shortHash(verdict.settlementTx),
      });
    } else if (verdict?.kind === "unlocked") {
      log({
        level: "warn",
        channel: "EVT",
        message: `IntentUnlocked · ${data.intent_id}`,
        details: shortHash(verdict.tx),
      });
    } else if (verdict) {
      log({
        level: "err",
        channel: "EVT",
        message: `${verdict.kind} (${verdict.where}) · ${verdict.reason}`,
      });
    }
  }, [settlementTerminal]);

  // ---------- TIMELINE STEPS ----------
  const startAt = lifecycle.steps.find((s) => s.key === "submit")?.at;
  const stepsByKey = useMemo(() => {
    const map = new Map<StepKey, TimingStep>();
    for (const s of lifecycle.steps) map.set(s.key, s);
    return map;
  }, [lifecycle.steps]);

  // Per-phase durations: each step's `at` minus its predecessor's `at` (in
  // chronological order, restricted to steps that actually render). Hidden
  // intermediate steps (e.g. `deposit` broadcast) don't contribute to a phase
  // boundary — `deposited`'s duration spans signing + block confirmation.
  const durationByKey = useMemo(() => {
    const map = new Map<StepKey, number>();
    const filtered = lifecycle.steps.filter(
      (s) => s.key === "submit" || RENDERED_KEYS.has(s.key)
    );
    for (let i = 1; i < filtered.length; i++) {
      const step = filtered[i];
      const prev = filtered[i - 1];
      if (step && prev) map.set(step.key, step.at - prev.at);
    }
    return map;
  }, [lifecycle.steps]);

  const elapsedMs = useMemo(() => {
    if (!startAt) return 0;
    const end = lifecycle.endedAt ?? Date.now();
    return end - startAt;
  }, [startAt, lifecycle.endedAt, lifecycle.steps]);

  const titleStatus = useMemo(() => {
    if (!intentId && lifecycle.steps.length === 0)
      return <PanelStatus state="idle">Standby</PanelStatus>;
    if (!data && lifecycle.steps.length > 0)
      return <PanelStatus state="live">Submitting…</PanelStatus>;
    if (!data) return <PanelStatus state="live">Loading…</PanelStatus>;
    if (lifecycle.endedAt !== null) {
      const v = terminalVerdict(data);
      if (v?.kind === "settled")
        return <PanelStatus state="ok">Settled</PanelStatus>;
      if (v?.kind === "unlocked")
        return <PanelStatus state="warn">Refunded</PanelStatus>;
      return <PanelStatus state="err">Terminal · error</PanelStatus>;
    }
    return <PanelStatus state="live">In flight</PanelStatus>;
  }, [intentId, data, lifecycle.endedAt, lifecycle.steps.length]);

  const showEmpty = lifecycle.steps.length === 0 && !intentId;

  return (
    <Panel title="Intent" status={titleStatus}>
      {showEmpty ? (
        <div className="intent__empty">
          <em>no active intent.</em>
          submit a swap to see its lifecycle here.
        </div>
      ) : (
        <div className="intent">
          <div className="intent__id">
            <span className="label">ID</span>
            <span>{lifecycle.intentId ?? intentId ?? "—"}</span>
            <span className="deadline">
              {lifecycle.endedAt !== null ? "TOTAL" : "ELAPSED"} ·{" "}
              {fmtMs(elapsedMs)}
            </span>
          </div>

          {data ? (
            <div className="intent-states">
              <div className={`state-pill ${pillState(data.order_state, true).cls}`}>
                <span className="label">Order state</span>
                <span className="value">
                  <Dot state={pillState(data.order_state, true).dot} />
                  {describeOrderState(data.order_state)}
                </span>
              </div>
              <div className="intent-states__sep">→</div>
              <div className={`state-pill ${pillState(data.settlement_state, false).cls}`}>
                <span className="label">Settlement state</span>
                <span className="value">
                  <Dot state={pillState(data.settlement_state, false).dot} />
                  {describeSettlementState(data.settlement_state)}
                </span>
              </div>
            </div>
          ) : null}

          <div className="intent__timeline">
            {STEP_ORDER.map(({ key, label }) => {
              const step = stepsByKey.get(key);
              const isLast =
                step &&
                lifecycle.steps[lifecycle.steps.length - 1]?.key === key &&
                lifecycle.endedAt === null;
              const duration = durationByKey.get(key);
              const cls = step
                ? step.ok === false
                  ? "intent__step is-err"
                  : isLast
                    ? "intent__step is-active"
                    : "intent__step is-done"
                : "intent__step";
              return (
                <div className={cls} key={key}>
                  <span className="glyph">
                    {step ? (step.ok === false ? "●" : "●") : "·"}
                  </span>
                  <span className="when">
                    {duration !== undefined ? fmtMs(duration) : "—"}
                  </span>
                  <span className="what">{step?.label ?? label}</span>
                  <span className="extra">
                    {step?.tx ? shortHash(step.tx) : step?.detail ?? ""}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}
