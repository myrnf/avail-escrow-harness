import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { Panel, PanelStatus } from "./primitives/Panel";
import { TokenPill } from "./primitives/TokenPill";
import { TokenSelect } from "./primitives/TokenSelect";
import { Chip } from "./primitives/Chip";
import { getToken, TOKEN_LIST_META, type TokenSymbol } from "../config/tokens";
import {
  DEFAULT_SLIPPAGE_BPS,
  SLIPPAGE_PRESETS_BPS,
} from "../config/avail";
import { useQuote } from "../hooks/useQuote";
import { useKyberQuote } from "../hooks/useKyberQuote";
import { useInputBalance, useTokenAllowance, useApprove } from "../hooks/useErc20";
import { useCreateIntent } from "../hooks/useIntent";
import { useDeposit } from "../hooks/useDeposit";
import { useActiveNetwork } from "../hooks/useActiveNetwork";
import { usePermit } from "../hooks/usePermit";
import { fmtAmount, parseAmount } from "../lib/format";
import { useActivityLog } from "../store/activityLog";
import { useCurrentLifecycle } from "../hooks/useCurrentLifecycle";

interface Props {
  isInFlight: boolean;
}

export function SwapForm({ isInFlight }: Props) {
  const { address, isConnected } = useAccount();
  const network = useActiveNetwork();
  // USDC is always the hub leg; the user picks the other (base) asset and which
  // side USDC sits on. This guarantees only USDC-quoted pairs (the only markets
  // KalqiX/Avail support) — no invalid cbBTC↔ETH combinations.
  const [pairedToken, setPairedToken] =
    useState<Exclude<TokenSymbol, "USDC">>("cbBTC");
  const [usdcSide, setUsdcSide] = useState<"in" | "out">("in");
  const tokenIn: TokenSymbol = usdcSide === "in" ? "USDC" : pairedToken;
  const tokenOut: TokenSymbol = usdcSide === "in" ? pairedToken : "USDC";
  const [amountInStr, setAmountInStr] = useState("");
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const log = useActivityLog((s) => s.push);
  const lifecycle = useCurrentLifecycle();

  const inInfo = getToken(network, tokenIn);
  const outInfo = getToken(network, tokenOut);

  // Non-USDC leg options for the token selector (cbBTC, ETH).
  const pairedOptions = TOKEN_LIST_META.filter((t) => t.symbol !== "USDC").map(
    (t) => getToken(network, t.symbol)
  );

  const amountIn = useMemo(() => {
    try {
      return parseAmount(amountInStr, inInfo.decimals);
    } catch {
      return 0n;
    }
  }, [amountInStr, inInfo.decimals]);

  const balance = useInputBalance(inInfo, address);
  // Native ETH is paid via msg.value — no ERC-20 allowance exists, so skip the
  // allowance read entirely (balanceOf/allowance on the 0xEeee… sentinel would
  // just revert).
  const allowance = useTokenAllowance(
    inInfo.address,
    address,
    network.escrowContract,
    !inInfo.isNative
  );
  const quote = useQuote({
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    enabled: amountIn > 0n && !isInFlight,
  });
  // KyberSwap aggregator benchmark (best on-chain DEX route) for the same swap.
  // Disabled where Kyber has no coverage (testnet) via network.kyberChainSlug.
  const kyber = useKyberQuote({
    tokenIn,
    tokenOut,
    amountIn,
    enabled: amountIn > 0n && !isInFlight,
  });
  // Deviation of our expected output vs Kyber's, in bps. + = we beat Kyber.
  const kyberDeviationBps =
    quote.data && kyber.data && kyber.data.amountOut > 0n
      ? Number(
          ((quote.data.amountOut - kyber.data.amountOut) * 10000n) /
            kyber.data.amountOut
        )
      : null;
  const approve = useApprove();
  const createIntent = useCreateIntent();
  const deposit = useDeposit();
  const { collectPermit } = usePermit();
  const [permitSigning, setPermitSigning] = useState(false);
  const [permitError, setPermitError] = useState<Error | null>(null);

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
    setPermitError(null);
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
    setUsdcSide((s) => (s === "in" ? "out" : "in"));
    setAmountInStr("");
    createIntent.reset();
    deposit.reset();
  }

  function selectPaired(symbol: TokenSymbol) {
    if (isInFlight || symbol === "USDC") return;
    setPairedToken(symbol as Exclude<TokenSymbol, "USDC">);
    setAmountInStr("");
    createIntent.reset();
    deposit.reset();
  }

  // Native ETH pays its own gas, so MAX can't be the full balance or the deposit
  // tx (msg.value == amountIn) leaves nothing for gas and the wallet rejects it.
  // Reserve a small headroom (Base L2 gas is sub-cent; 0.0001 ETH is ample).
  // ERC-20s pay gas separately, so MAX = full balance.
  const NATIVE_GAS_RESERVE = 100_000_000_000_000n; // 0.0001 ETH

  function setMax() {
    if (typeof balance.data !== "bigint") return;
    const bal = balance.data as bigint;
    const usable = inInfo.isNative
      ? bal > NATIVE_GAS_RESERVE
        ? bal - NATIVE_GAS_RESERVE
        : 0n
      : bal;
    setAmountInStr(
      fmtAmount(usable, inInfo.decimals, {
        minDp: 0,
        maxDp: inInfo.decimals,
      }).replace(/,/g, "")
    );
  }

  // Native ETH never needs an approval (paid via msg.value). For ERC-20s,
  // compare the escrow allowance against the input amount.
  const needsApprove =
    !inInfo.isNative &&
    typeof allowance.data === "bigint" &&
    amountIn > 0n
      ? (allowance.data as bigint) < amountIn
      : false;

  // When the token supports EIP-2612 and allowance is insufficient, the permit
  // signature replaces the separate approve() tx — one wallet popup for the
  // whole swap. Without permit support, we keep the two-tx fallback (approve
  // first, then confirm).
  const usePermitFlow = needsApprove && inInfo.supportsPermit;

  async function onConfirm() {
    if (!quote.data) return;
    try {
      lifecycle.start();
      setPermitError(null);
      const fresh = await quote.refetch();
      const q = fresh.data ?? quote.data;
      // Snapshot the Kyber benchmark at submit so the execution panel can show
      // actual-vs-Kyber after settlement. null if Kyber is unavailable here.
      lifecycle.setKyberAmountOut(
        kyber.data ? kyber.data.amountOut.toString() : null
      );
      log({
        level: "info",
        channel: "QUOTE",
        message: `submit · ${fmtAmount(q.amountIn, q.amountInDecimals)} ${tokenIn} → min ${fmtAmount(q.amountOutMin, q.amountOutDecimals)} ${tokenOut}`,
      });

      let permit: string | null = null;
      if (usePermitFlow && address) {
        try {
          setPermitSigning(true);
          // 1-hour permit deadline gives wide margin over Avail's ~60s
          // server-side intent deadline. The permit lives only for this tx.
          const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
          permit = await collectPermit({
            token: inInfo,
            spender: network.escrowContract,
            value: q.amountIn,
            deadline: permitDeadline,
          });
          lifecycle.recordStep({
            key: "permit",
            at: Date.now(),
            label: "Permit signed (off-chain)",
            ok: true,
          });
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          setPermitError(err);
          log({
            level: "warn",
            channel: "SIG",
            message: `permit signature rejected · ${err.message}`,
          });
          throw err;
        } finally {
          setPermitSigning(false);
        }
      }

      const intent = await createIntent.mutateAsync({
        token_in: inInfo.address,
        token_out: outInfo.address,
        amount_in: q.amountIn.toString(),
        amount_out: q.amountOutMin.toString(),
        // Optional telemetry: gross expected output, pre-slippage. Lets Avail
        // see what we quoted vs what we'll accept as a slippage floor.
        amount_out_quote: q.amountOut.toString(),
        client_intent_id: `harness-${Date.now()}`,
        permit,
      });
      // Native ETH is paid as msg.value; AvailEscrow.deposit() requires
      // msg.value == amountIn exactly (reverts InvalidMsgValue otherwise) and
      // forbids a permit. ERC-20s send 0 value and rely on permit/allowance.
      deposit.deposit({
        to: intent.contract_address,
        data: intent.encoded_calldata,
        value: inInfo.isNative ? q.amountIn : 0n,
      });
    } catch {
      // createIntent / mutateAsync / permit-sign errors surface via the inline
      // error block + activity log.
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
  } else if (permitSigning) {
    ctaLabel = "Awaiting permit signature…";
    ctaDisabled = true;
    ctaShowSpinner = true;
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
  } else if (needsApprove && !usePermitFlow) {
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

  const error =
    permitError || createIntent.error || deposit.error || approve.error;
  const formDisabled =
    isInFlight ||
    approve.isPending ||
    permitSigning ||
    !network.configured;

  const stakesAffix =
    network.stakes === "real" ? (
      <span className="panel__head-affix is-real">(real money)</span>
    ) : (
      <span className="panel__head-affix is-fake">(fake money)</span>
    );

  return (
    <Panel
      title="Swap"
      titleAffix={stakesAffix}
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
        {inInfo.symbol === "USDC" ? (
          <TokenPill token={inInfo} />
        ) : (
          <TokenSelect
            value={inInfo}
            options={pairedOptions}
            onSelect={selectPaired}
            disabled={formDisabled}
          />
        )}
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
        {outInfo.symbol === "USDC" ? (
          <TokenPill token={outInfo} />
        ) : (
          <TokenSelect
            value={outInfo}
            options={pairedOptions}
            onSelect={selectPaired}
            disabled={formDisabled}
          />
        )}
      </div>

      {/* Details */}
      <div className="swap__details">
        <div className="swap__line">
          <span>{quote.data?.side === "BUY" ? "Best ask" : "Best bid"}</span>
          <b className="num">
            {quote.data
              ? `${quote.data.priceHuman.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC / ${pairedToken}`
              : "—"}
          </b>
        </div>
        {quote.data?.takerFeeBps != null ? (
          <div className="swap__line">
            <span>Taker fee</span>
            <span className="num">
              {(quote.data.takerFeeBps / 100).toFixed(2)} %
            </span>
          </div>
        ) : null}
        <div className="swap__line">
          <span>Min received</span>
          <b className="num">
            {quote.data
              ? `${fmtAmount(quote.data.amountOutMin, outInfo.decimals)} ${tokenOut}`
              : "—"}
          </b>
        </div>
        {network.kyberChainSlug ? (
          <div className="swap__line">
            <span>Kyberswap est.</span>
            {kyber.data ? (
              <span className="num">
                {fmtAmount(kyber.data.amountOut, outInfo.decimals)} {tokenOut}
                {kyberDeviationBps !== null ? (
                  <span
                    className={`swap__dev ${kyberDeviationBps >= 0 ? "is-better" : "is-worse"}`}
                  >
                    {" "}
                    {kyberDeviationBps >= 0 ? "+" : ""}
                    {(kyberDeviationBps / 100).toFixed(2)}% vs Kyber
                  </span>
                ) : null}
              </span>
            ) : kyber.isError ? (
              <span className="err">unavailable</span>
            ) : (
              <span className="num">…</span>
            )}
          </div>
        ) : null}
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
