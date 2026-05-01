import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { Panel, PanelStatus } from "./primitives/Panel";
import { TokenPill } from "./primitives/TokenPill";
import { Chip } from "./primitives/Chip";
import { getToken, type TokenSymbol } from "../config/tokens";
import {
  DEFAULT_SLIPPAGE_BPS,
  SLIPPAGE_PRESETS_BPS,
} from "../config/avail";
import { useQuote } from "../hooks/useQuote";
import { useTokenBalance, useTokenAllowance, useApprove } from "../hooks/useErc20";
import { useCreateIntent } from "../hooks/useIntent";
import { useDeposit } from "../hooks/useDeposit";
import { useActiveNetwork } from "../hooks/useActiveNetwork";
import { fmtAmount, parseAmount } from "../lib/format";
import { useActivityLog } from "../store/activityLog";
import { useCurrentLifecycle } from "../hooks/useCurrentLifecycle";

interface Props {
  isInFlight: boolean;
}

export function SwapForm({ isInFlight }: Props) {
  const { address, isConnected } = useAccount();
  const network = useActiveNetwork();
  const [tokenIn, setTokenIn] = useState<TokenSymbol>("USDC");
  const [tokenOut, setTokenOut] = useState<TokenSymbol>("cbBTC");
  const [amountInStr, setAmountInStr] = useState("");
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const log = useActivityLog((s) => s.push);
  const lifecycle = useCurrentLifecycle();

  const inInfo = getToken(network, tokenIn);
  const outInfo = getToken(network, tokenOut);

  const amountIn = useMemo(() => {
    try {
      return parseAmount(amountInStr, inInfo.decimals);
    } catch {
      return 0n;
    }
  }, [amountInStr, inInfo.decimals]);

  const balance = useTokenBalance(inInfo.address, address);
  const allowance = useTokenAllowance(
    inInfo.address,
    address,
    network.escrowContract
  );
  const quote = useQuote({
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    enabled: amountIn > 0n && !isInFlight,
  });
  const approve = useApprove();
  const createIntent = useCreateIntent();
  const deposit = useDeposit();

  // Quote refresh countdown.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!quote.data) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [quote.data?.fetchedAt]);
  const secondsToRefresh = quote.data
    ? Math.max(0, 5 - Math.floor((Date.now() - quote.data.fetchedAt) / 1000))
    : null;

  // Refetch allowance after approve confirms — with a backoff retry chain to
  // tolerate RPC eventual-consistency lag (public Base Sepolia RPC round-robins
  // across nodes, so the post-receipt read can land on a node that hasn't seen
  // the new block yet).
  useEffect(() => {
    if (!approve.isSuccess) return;
    const delays = [400, 1200, 2500, 5000, 10000];
    const timers = delays.map((d) =>
      setTimeout(() => {
        void allowance.refetch();
      }, d)
    );
    return () => timers.forEach(clearTimeout);
  }, [approve.isSuccess]);

  // Reset local form + mutation state when the harness network changes —
  // addresses and escrow contract differ. The lifecycle store is keyed by
  // network and preserves history per-network, so we don't reset it here.
  useEffect(() => {
    setAmountInStr("");
    createIntent.reset();
    deposit.reset();
    approve.reset();
  }, [network.key]);

  // ---------- LIFECYCLE RECORDING ----------
  // createIntent succeeded → record + propagate intent ID up.
  useEffect(() => {
    if (createIntent.isSuccess && createIntent.data) {
      lifecycle.setIntentId(createIntent.data.id);
      lifecycle.recordStep({
        key: "createIntent",
        at: Date.now(),
        label: "POST /intent",
        ok: true,
        detail: `solver ${createIntent.data.solver_address.slice(0, 6)}…${createIntent.data.solver_address.slice(-4)}`,
      });
    }
  }, [createIntent.isSuccess, createIntent.data?.id]);

  // deposit tx broadcast → record + clear the form. Once the user has signed
  // the deposit there's no rolling back this swap, so the form should be
  // ready for the next one. createIntent/deposit failures *before* this point
  // intentionally leave the form populated so the user can retry.
  useEffect(() => {
    if (deposit.txHash) {
      lifecycle.recordStep({
        key: "deposit",
        at: Date.now(),
        label: "Deposit broadcast",
        ok: true,
        tx: deposit.txHash,
      });
      setAmountInStr("");
    }
  }, [deposit.txHash]);

  // deposit confirmed (IntentDeposited) → record.
  useEffect(() => {
    if (deposit.isSuccess && deposit.txHash) {
      lifecycle.recordStep({
        key: "deposited",
        at: Date.now(),
        label: "User deposited (IntentDeposited)",
        ok: true,
        tx: deposit.txHash,
      });
    }
  }, [deposit.isSuccess, deposit.txHash]);

  // After successful terminal lifecycle, reset local mutation state so the next
  // submit starts fresh. Triggered by lifecycle.endedAt.
  useEffect(() => {
    if (lifecycle.endedAt !== null) {
      // small grace period so the UI shows terminal state before reset
      const id = setTimeout(() => {
        createIntent.reset();
        deposit.reset();
        approve.reset();
      }, 1500);
      return () => clearTimeout(id);
    }
  }, [lifecycle.endedAt]);

  function flip() {
    if (isInFlight) return;
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountInStr("");
    createIntent.reset();
    deposit.reset();
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

  const needsApprove =
    typeof allowance.data === "bigint" && amountIn > 0n
      ? allowance.data < amountIn
      : false;

  async function onConfirm() {
    if (!quote.data) return;
    try {
      lifecycle.start();
      const fresh = await quote.refetch();
      const q = fresh.data ?? quote.data;
      log({
        level: "info",
        channel: "QUOTE",
        message: `submit · ${fmtAmount(q.amountIn, q.amountInDecimals)} ${tokenIn} → min ${fmtAmount(q.amountOutMin, q.amountOutDecimals)} ${tokenOut}`,
      });
      const intent = await createIntent.mutateAsync({
        token_in: inInfo.address,
        token_out: outInfo.address,
        amount_in: q.amountIn.toString(),
        amount_out: q.amountOutMin.toString(),
        client_intent_id: `harness-${Date.now()}`,
      });
      deposit.deposit({
        to: intent.contract_address,
        data: intent.encoded_calldata,
        value: 0n,
      });
    } catch {
      // createIntent / mutateAsync errors surface via createIntent.error
      lifecycle.reset();
    }
  }

  // ---------- CTA STATE MACHINE ----------
  let ctaLabel: React.ReactNode = "Confirm swap";
  let ctaDisabled = false;
  let ctaAction: () => void = onConfirm;
  let ctaShowSpinner = false;

  if (!network.configured) {
    ctaLabel = `${network.shortLabel} not configured`;
    ctaDisabled = true;
  } else if (!isConnected) {
    ctaLabel = "Connect wallet";
    ctaDisabled = true;
  } else if (createIntent.isPending) {
    ctaLabel = "Creating intent…";
    ctaDisabled = true;
    ctaShowSpinner = true;
  } else if (deposit.isPending) {
    ctaLabel = "Awaiting deposit…";
    ctaDisabled = true;
    ctaShowSpinner = true;
  } else if (isInFlight) {
    ctaLabel = "Swap in flight";
    ctaDisabled = true;
    ctaShowSpinner = true;
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
  } else if (needsApprove) {
    if (approve.isPending) {
      ctaLabel = "Approving…";
      ctaDisabled = true;
      ctaShowSpinner = true;
    } else {
      ctaLabel = `Approve ${tokenIn}`;
      ctaAction = () =>
        approve.approve(inInfo.address, network.escrowContract, amountIn);
    }
  }

  const error = createIntent.error || deposit.error || approve.error;
  const formDisabled = isInFlight || approve.isPending || !network.configured;

  return (
    <Panel
      title="Swap"
      status={
        isInFlight ? (
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
              ? `${quote.data.priceHuman.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC / BTC`
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
            {isInFlight
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
        {quote.data && !ctaDisabled ? (
          <span className="quote-tick">REFRESH {secondsToRefresh ?? 0}s</span>
        ) : null}
      </button>

      {error ? (
        <div className="swap__error">
          {error instanceof Error ? error.message : String(error)}
        </div>
      ) : null}

      <span style={{ display: "none" }}>{tick}</span>
    </Panel>
  );
}
