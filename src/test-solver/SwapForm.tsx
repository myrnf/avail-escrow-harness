import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { Panel, PanelStatus } from "../components/primitives/Panel";
import { TokenPill } from "../components/primitives/TokenPill";
import { Chip } from "../components/primitives/Chip";
import { NETWORKS } from "../config/networks";
import { getToken, type TokenSymbol } from "../config/tokens";
import {
  DEFAULT_SLIPPAGE_BPS,
  SLIPPAGE_PRESETS_BPS,
} from "../config/avail";
import { useQuote } from "../hooks/useQuote";
import { useTokenBalance } from "../hooks/useErc20";
import { fmtAmount, parseAmount } from "../lib/format";
import { useSwapSession } from "./hooks/useSwapSession";
import type { Algo } from "./lib/types";

const NETWORK = NETWORKS.canary; // test-solver is implicitly Base mainnet
const ALGO_OPTIONS: { key: Algo; label: string; hint: string }[] = [
  { key: "clear_min", label: "A · clear min", hint: "current avail behavior" },
  { key: "maximize_fill", label: "B · market FOK", hint: "kalqix walks the book" },
  { key: "max_fill_limit", label: "C · limit FOK", hint: "harness walks the book" },
];

export function SwapForm() {
  const { address, isConnected } = useAccount();
  const [tokenIn, setTokenIn] = useState<TokenSymbol>("USDC");
  const [tokenOut, setTokenOut] = useState<TokenSymbol>("cbBTC");
  const [amountInStr, setAmountInStr] = useState("");
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const [algo, setAlgo] = useState<Algo>("clear_min");

  const session = useSwapSession();

  const inInfo = getToken(NETWORK, tokenIn);
  const outInfo = getToken(NETWORK, tokenOut);
  const amountIn = useMemo(() => {
    try {
      return parseAmount(amountInStr, inInfo.decimals);
    } catch {
      return 0n;
    }
  }, [amountInStr, inInfo.decimals]);

  const balance = useTokenBalance(inInfo.address, address);
  const quote = useQuote({
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    enabled: amountIn > 0n && !session.isInFlight,
  });

  // Refresh-tick countdown.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!quote.data) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [quote.data?.fetchedAt]);
  const secondsToRefresh = quote.data
    ? Math.max(0, 5 - Math.floor((Date.now() - quote.data.fetchedAt) / 1000))
    : null;

  function flip() {
    if (session.isInFlight) return;
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountInStr("");
  }

  function setMax() {
    if (typeof balance.data === "bigint") {
      setAmountInStr(
        fmtAmount(balance.data as bigint, inInfo.decimals, {
          minDp: 0,
          maxDp: inInfo.decimals,
        }).replace(/,/g, "")
      );
    }
  }

  async function onConfirm() {
    if (!quote.data) return;
    const fresh = await quote.refetch();
    const q = fresh.data ?? quote.data;
    await session.start({
      side: q.side,
      algo,
      tokenIn: inInfo.address,
      tokenOut: outInfo.address,
      amountIn: q.amountIn,
      amountOutMin: q.amountOutMin,
      amountOutQuote: q.amountOut,
    });
  }

  // CTA labels for the current session phase.
  let ctaLabel: React.ReactNode = "Confirm swap";
  let ctaDisabled = false;
  let ctaAction: () => void = onConfirm;
  let ctaShowSpinner = false;

  if (!isConnected) {
    ctaLabel = "Connect wallet";
    ctaDisabled = true;
  } else if (session.phase === "requesting") {
    ctaLabel = "Creating swap…";
    ctaDisabled = true;
    ctaShowSpinner = true;
  } else if (session.phase === "awaitingSignature") {
    ctaLabel = "Awaiting wallet signature…";
    ctaDisabled = true;
    ctaShowSpinner = true;
  } else if (session.phase === "awaitingDepositTx") {
    ctaLabel = "Awaiting deposit confirmation…";
    ctaDisabled = true;
    ctaShowSpinner = true;
  } else if (session.phase === "polling") {
    ctaLabel = "Solver executing…";
    ctaDisabled = true;
    ctaShowSpinner = true;
  } else if (session.phase === "done") {
    ctaLabel = "Start another swap";
    ctaAction = session.reset;
  } else if (amountIn === 0n) {
    ctaLabel = "Enter an amount";
    ctaDisabled = true;
  } else if (typeof balance.data === "bigint" && amountIn > balance.data) {
    ctaLabel = `Insufficient ${tokenIn}`;
    ctaDisabled = true;
  } else if (quote.isFetching && !quote.data) {
    ctaLabel = "Quoting…";
    ctaDisabled = true;
    ctaShowSpinner = true;
  } else if (quote.isError) {
    ctaLabel = "Quote unavailable";
    ctaDisabled = true;
  }

  const formDisabled = session.isInFlight || session.phase === "done";

  return (
    <Panel
      title="Swap"
      titleAffix={<span className="panel__head-affix is-real">(real money)</span>}
      status={
        session.isInFlight ? (
          <PanelStatus state="warn">Locked</PanelStatus>
        ) : quote.data ? (
          <PanelStatus state="live">Live · {secondsToRefresh ?? 0}s</PanelStatus>
        ) : (
          <PanelStatus state="idle">Idle</PanelStatus>
        )
      }
    >
      {/* Pay row */}
      <div className="swap__row">
        <div>
          <div className="swap__legend">You pay</div>
          <input
            className="swap__amount"
            inputMode="decimal"
            placeholder="0.00"
            value={amountInStr}
            onChange={(e) => setAmountInStr(e.target.value)}
            disabled={formDisabled}
          />
          <div className="swap__balance">
            Balance{" "}
            {balance.data !== undefined
              ? fmtAmount(balance.data as bigint, inInfo.decimals, { minDp: 0 })
              : "—"}{" "}
            {tokenIn}
            {isConnected && balance.data !== undefined && !formDisabled ? (
              <button className="max" type="button" onClick={setMax}>
                MAX
              </button>
            ) : null}
          </div>
        </div>
        <TokenPill token={inInfo} />
      </div>

      <div className="swap__divider">
        <button
          type="button"
          className="swap__flip"
          onClick={flip}
          disabled={formDisabled}
          aria-label="Flip direction"
        >
          <svg viewBox="0 0 24 24">
            <path d="M7 4v12m0 0l-3-3m3 3l3-3M17 20V8m0 0l-3 3m3-3l3 3" />
          </svg>
        </button>
      </div>

      {/* Receive row */}
      <div className="swap__row">
        <div>
          <div className="swap__legend">You receive</div>
          <input
            className="swap__amount"
            value={
              quote.data ? fmtAmount(quote.data.amountOut, outInfo.decimals) : ""
            }
            placeholder="0.00"
            readOnly
            disabled={formDisabled}
          />
          <div className="swap__balance">
            Balance — <span style={{ marginLeft: 4 }}>{tokenOut}</span>
          </div>
        </div>
        <TokenPill token={outInfo} />
      </div>

      {/* Details */}
      <div className="swap__details">
        <div className="swap__line">
          <span>{quote.data?.side === "BUY" ? "Best ask" : "Best bid"}</span>
          <b className="num">
            {quote.data
              ? `${quote.data.priceHuman.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })} USDC / BTC`
              : "—"}
          </b>
        </div>
        <div className="swap__line">
          <span>Taker fee</span>
          <span className="num">
            {quote.data ? `${(quote.data.takerFeeBps / 100).toFixed(2)} %` : "—"}
          </span>
        </div>
        <div className="swap__line">
          <span>Min received</span>
          <b className="num">
            {quote.data
              ? `${fmtAmount(quote.data.amountOutMin, outInfo.decimals)} ${tokenOut}`
              : "—"}
          </b>
        </div>
        <div className="swap__line">
          <span>Quote refresh</span>
          <span className="num">
            {session.isInFlight
              ? "paused"
              : quote.data
                ? `in ${secondsToRefresh ?? 0}s`
                : "—"}
          </span>
        </div>
        {quote.isError ? (
          <div className="swap__line">
            <span>Status</span>
            <span className="err">
              {quote.error instanceof Error ? quote.error.message : "Quote unavailable"}
            </span>
          </div>
        ) : null}
      </div>

      {/* Algo selector */}
      <div className="swap__slip" style={{ borderTop: "1px solid var(--hairline)" }}>
        <span className="swap__slip-label">Algo</span>
        {ALGO_OPTIONS.map((opt) => (
          <Chip
            key={opt.key}
            active={algo === opt.key}
            onClick={() => !formDisabled && setAlgo(opt.key)}
          >
            {opt.label}
          </Chip>
        ))}
      </div>

      {/* Slippage */}
      <div className="swap__slip">
        <span className="swap__slip-label">Slippage</span>
        {SLIPPAGE_PRESETS_BPS.map((bps) => (
          <Chip
            key={bps}
            active={slippageBps === bps}
            onClick={() => !formDisabled && setSlippageBps(bps)}
          >
            {(bps / 100).toFixed(2)} %
          </Chip>
        ))}
      </div>

      {/* CTA */}
      <button
        type="button"
        className="swap__cta"
        onClick={ctaAction}
        disabled={ctaDisabled}
      >
        <span className="swap__cta-label">
          {ctaShowSpinner ? <span className="spinner" aria-hidden /> : null}
          {ctaLabel}
        </span>
      </button>

      {session.error ? (
        <div className="swap__error">
          {session.error instanceof Error
            ? session.error.message
            : String(session.error)}
        </div>
      ) : null}

      <span style={{ display: "none" }}>{tick}</span>
    </Panel>
  );
}
