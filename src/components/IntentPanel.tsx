import { useEffect, useMemo, useState } from "react";
import { Panel, PanelStatus, Dot } from "./primitives/Panel";
import { useIntentStatus } from "../hooks/useIntent";
import type { SettlementPhase, TradePhase } from "../lib/intent";
import { shortHash } from "../lib/format";
import { useActivityLog } from "../store/activityLog";
import { type StepKey, type TimingStep } from "../store/intentTiming";
import { useCurrentLifecycle } from "../hooks/useCurrentLifecycle";
import { useActiveNetwork } from "../hooks/useActiveNetwork";


// "submit" is the timeline anchor used to compute the first phase duration —
// not rendered as its own row (it's always 0ms, so not informative).
// "deposit" (broadcast) is still recorded in the lifecycle so the Transactions
// panel can show the tx hash the moment MetaMask returns, but it's collapsed
// into the "deposit confirmed" row in this timeline — duration on that row is
// the full sign-and-mine wall time.
// "permit" is only rendered when the swap actually collected one (canary/mainnet
// + ERC20 paths); testnet swaps skip the row entirely.
const KALQIX_STEP_ORDER: { key: StepKey; label: string }[] = [
  { key: "permit", label: "Permit signed (off-chain)" },
  { key: "createIntent", label: "POST /intent" },
  { key: "deposited", label: "User deposited (IntentDeposited)" },
  { key: "fill", label: "KalqiX fill" },
  // Default to the happy-path label; if the swap unwinds, the recorded step
  // overrides this with "User refunded (IntentUnlocked)" at settlement time.
  { key: "settled", label: "User filled (IntentSettled)" },
];

// KYBERSWAP: no escrow, no solver, no settlement — the router tx receipt is
// the terminal state. "routerTx" (broadcast) is collapsed into the confirmed
// row the same way "deposit" is above.
const KYBER_STEP_ORDER: { key: StepKey; label: string }[] = [
  { key: "createIntent", label: "POST /intent" },
  { key: "routerConfirmed", label: "Router swap confirmed" },
];

function tradePill(phase: TradePhase): {
  cls: string;
  dot: "idle" | "live" | "warn" | "ok" | "err";
} {
  if (phase === "pending") return { cls: "is-pending", dot: "live" };
  if (phase === "ok") return { cls: "is-ok", dot: "ok" };
  if (phase === "failed") return { cls: "is-err", dot: "err" };
  if (phase === "no_match" || phase === "expired")
    return { cls: "is-err", dot: "warn" };
  return { cls: "", dot: "idle" };
}

function settlementPill(phase: SettlementPhase): {
  cls: string;
  dot: "idle" | "live" | "warn" | "ok" | "err";
} {
  if (phase === "pending") return { cls: "is-pending", dot: "live" };
  if (phase === "settled") return { cls: "is-ok", dot: "ok" };
  if (phase === "unlocked") return { cls: "is-err", dot: "warn" };
  if (phase === "failed") return { cls: "is-err", dot: "err" };
  return { cls: "", dot: "idle" };
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function IntentPanel() {
  const network = useActiveNetwork();
  const lifecycle = useCurrentLifecycle();
  const isKyber = lifecycle.venue === "KYBERSWAP";
  // KYBERSWAP swaps have no backend lifecycle — never poll /v2/intent for
  // them; the router tx receipt (recorded by SwapForm) is terminal.
  const intentId = isKyber ? null : lifecycle.intentId;
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

  // ---------- LIFECYCLE: detect trade terminal (KALQIX only) ----------
  const tradeTerminal = data ? data.isTradeTerminal : false;
  useEffect(() => {
    if (!data || !tradeTerminal) return;
    lifecycle.recordStep({
      key: "fill",
      at: Date.now(),
      label: "KalqiX fill",
      ok: data.trade.phase === "ok",
      detail: data.trade.detail,
    });
  }, [tradeTerminal]);

  // ---------- LIFECYCLE: detect end state (KALQIX only) ----------
  // endStep is prepared by the status view: settlement went terminal, or the
  // intent died without settlement ever initiating (v2 expiry edge). Either
  // way the lifecycle must end, or isInFlight locks the swap CTA forever.
  const hasEndStep = !!data?.endStep;
  useEffect(() => {
    if (!data?.endStep) return;
    lifecycle.recordStep({
      key: "settled",
      at: Date.now(),
      ...data.endStep,
    });
    lifecycle.end(Date.now());

    // Activity log
    const verdict = data.terminal;
    if (verdict?.kind === "settled") {
      log({
        level: "ok",
        channel: "EVT",
        message: `IntentSettled · ${data.id}`,
        details: shortHash(verdict.settlementTx),
      });
    } else if (verdict?.kind === "unlocked") {
      log({
        level: "warn",
        channel: "EVT",
        message: `IntentUnlocked · ${data.id}`,
        details: verdict.tx ? shortHash(verdict.tx) : "no tx hash",
      });
    } else if (verdict) {
      log({
        level: "err",
        channel: "EVT",
        message: `${verdict.kind} (${verdict.where}) · ${verdict.reason}`,
      });
    }
  }, [hasEndStep]);

  // ---------- TIMELINE STEPS ----------
  const stepOrder = isKyber ? KYBER_STEP_ORDER : KALQIX_STEP_ORDER;
  const renderedKeys = useMemo(
    () => new Set<StepKey>(stepOrder.map((s) => s.key)),
    [stepOrder]
  );

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
      (s) => s.key === "submit" || renderedKeys.has(s.key)
    );
    for (let i = 1; i < filtered.length; i++) {
      const step = filtered[i];
      const prev = filtered[i - 1];
      if (step && prev) map.set(step.key, step.at - prev.at);
    }
    return map;
  }, [lifecycle.steps, renderedKeys]);

  const elapsedMs = useMemo(() => {
    if (!startAt) return 0;
    const end = lifecycle.endedAt ?? Date.now();
    return end - startAt;
  }, [startAt, lifecycle.endedAt, lifecycle.steps]);

  const titleStatus = useMemo(() => {
    if (!intentId && lifecycle.steps.length === 0)
      return <PanelStatus state="idle">Standby</PanelStatus>;
    // KYBERSWAP: terminal state comes from the recorded receipt step, not
    // poll data (which stays undefined for router swaps).
    if (isKyber) {
      if (lifecycle.endedAt !== null) {
        const confirmed = lifecycle.steps.find(
          (s) => s.key === "routerConfirmed"
        );
        return confirmed?.ok ? (
          <PanelStatus state="ok">Swapped</PanelStatus>
        ) : (
          <PanelStatus state="err">Terminal · error</PanelStatus>
        );
      }
      return <PanelStatus state="live">In flight</PanelStatus>;
    }
    // Ended with no poll data: the tx was rejected/reverted before any
    // backend state existed (SwapForm ends the lifecycle to unlock the CTA).
    if (!data && lifecycle.endedAt !== null)
      return <PanelStatus state="err">Terminal · error</PanelStatus>;
    if (!data && lifecycle.steps.length > 0)
      return <PanelStatus state="live">Submitting…</PanelStatus>;
    if (!data) return <PanelStatus state="live">Loading…</PanelStatus>;
    if (lifecycle.endedAt !== null) {
      const v = data.terminal;
      if (v?.kind === "settled")
        return <PanelStatus state="ok">Settled</PanelStatus>;
      if (v?.kind === "unlocked")
        return <PanelStatus state="warn">Refunded</PanelStatus>;
      return <PanelStatus state="err">Terminal · error</PanelStatus>;
    }
    return <PanelStatus state="live">In flight</PanelStatus>;
  }, [intentId, isKyber, data, lifecycle.endedAt, lifecycle.steps]);

  const showEmpty = lifecycle.steps.length === 0 && !intentId;
  // Venue badge only where a venue choice exists (multi-venue envs) — the
  // testnet single-venue UI stays exactly as before.
  const showVenueBadge =
    !!lifecycle.venue && (network.venues?.length ?? 0) > 1;

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
            <span>
              {showVenueBadge ? (
                <span className="venue-badge">{lifecycle.venue}</span>
              ) : null}
              {lifecycle.intentId ?? intentId ?? "—"}
            </span>
            <span className="deadline">
              {lifecycle.endedAt !== null ? "TOTAL" : "ELAPSED"} ·{" "}
              {fmtMs(elapsedMs)}
            </span>
          </div>

          {data && !isKyber ? (
            <div className="intent-states">
              <div className={`state-pill ${tradePill(data.trade.phase).cls}`}>
                <span className="label">Order state</span>
                <span className="value">
                  <Dot state={tradePill(data.trade.phase).dot} />
                  {data.trade.text}
                </span>
              </div>
              <div className="intent-states__sep">→</div>
              <div
                className={`state-pill ${settlementPill(data.settlement.phase).cls}`}
              >
                <span className="label">Settlement state</span>
                <span className="value">
                  <Dot state={settlementPill(data.settlement.phase).dot} />
                  {data.settlement.text}
                </span>
              </div>
            </div>
          ) : null}

          <div className="intent__timeline">
            {stepOrder
              .filter(({ key }) => key !== "permit" || stepsByKey.has("permit"))
              .map(({ key, label }) => {
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
