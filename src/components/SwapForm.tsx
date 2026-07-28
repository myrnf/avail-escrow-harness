import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { Panel, PanelStatus } from "./primitives/Panel";
import { TokenPill } from "./primitives/TokenPill";
import { TokenSelect } from "./primitives/TokenSelect";
import { Chip } from "./primitives/Chip";
import { VenueQuoteCards, type VenueCardModel } from "./VenueQuoteCards";
import { getToken, TOKEN_LIST_META, type TokenSymbol } from "../config/tokens";
import {
  DEFAULT_SLIPPAGE_BPS,
  SLIPPAGE_PRESETS_BPS,
  QUOTE_TTL_MS,
  KYBERSWAP_TOKEN_ALLOWLIST,
} from "../config/avail";
import { venueEnabled, type Venue } from "../config/networks";
import { useQuote } from "../hooks/useQuote";
import { useKyberQuote } from "../hooks/useKyberQuote";
import { useSupportedTokens } from "../hooks/useSupportedTokens";
import { useInputBalance, useTokenAllowance, useApprove } from "../hooks/useErc20";
import { useCreateIntent } from "../hooks/useIntent";
import { useDeposit } from "../hooks/useDeposit";
import { useActiveNetwork } from "../hooks/useActiveNetwork";
import { usePermit } from "../hooks/usePermit";
import { fmtAmount, parseAmount } from "../lib/format";
import { ServiceUnavailableError } from "../lib/quote/apiClient";
import type { MultiQuote, VenueQuote } from "../lib/quote/types";
import { AvailIntentError, type CreateIntentRequest } from "../lib/intent";
import { receiptAmountOut } from "../lib/chain/receipt";
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
  // null = auto (best venue); set when the user picks a card explicitly.
  const [venueOverride, setVenueOverride] = useState<Venue | null>(null);
  // Submit-time failures (stale quote, integrity check) that have no
  // mutation-state channel of their own.
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const log = useActivityLog((s) => s.push);
  const lifecycle = useCurrentLifecycle();

  const inInfo = getToken(network, tokenIn);
  const outInfo = getToken(network, tokenOut);
  const isMultiVenue = (network.venues?.length ?? 0) > 1;

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

  // A venue is unavailable when the app-side token allowlist excludes the
  // pair (KYBERSWAP quotes any token and enforces no supported-token checks —
  // the app owns that policy) or when amount_in is outside the venue's
  // /supported-token limits. Either way the venue is excluded from the quote
  // and rendered as a disabled card with the reason, instead of letting it
  // fail server-side.
  const supported = useSupportedTokens();
  const kyberPairAllowed =
    (KYBERSWAP_TOKEN_ALLOWLIST as readonly string[]).includes(tokenIn) &&
    (KYBERSWAP_TOKEN_ALLOWLIST as readonly string[]).includes(tokenOut);
  const venueStates = (network.venues ?? []).map((venue) => {
    let reason: string | null = null;
    if (venue === "KYBERSWAP" && !kyberPairAllowed) {
      reason = "ETH pairs not routed via KyberSwap";
    } else {
      const violation = supported.violation(venue, inInfo.address, amountIn);
      if (violation) {
        reason = `${violation.kind === "below_min" ? "below venue min" : "above venue max"} · ${fmtAmount(violation.limit, inInfo.decimals, { minDp: 0 })} ${tokenIn}`;
      }
    }
    return { venue, reason };
  });
  const allowedVenues = venueStates
    .filter((s) => !s.reason)
    .map((s) => s.venue);

  const quote = useQuote({
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    venues: network.venues ? allowedVenues : undefined,
    enabled: amountIn > 0n && !isInFlight,
  });
  const quotes = quote.data?.quotes ?? [];
  // Auto-select the best (first) venue; a user override sticks across the 5s
  // refresh while that venue keeps succeeding, and falls back to best if it
  // drops out.
  const selected: VenueQuote | null =
    quotes.find((q) => q.venue === venueOverride) ?? quotes[0] ?? null;

  // KyberSwap aggregator benchmark (direct API call) — only where Kyber has
  // coverage AND isn't already a first-class venue (i.e. legacy mainnet).
  // On canary the KYBERSWAP venue card replaces this row.
  const showKyberBenchmark =
    !!network.kyberChainSlug && !venueEnabled(network, "KYBERSWAP");
  const kyber = useKyberQuote({
    tokenIn,
    tokenOut,
    amountIn,
    enabled: amountIn > 0n && !isInFlight && showKyberBenchmark,
  });
  // Deviation of our expected output vs Kyber's, in bps. + = we beat Kyber.
  const kyberDeviationBps =
    selected && kyber.data && kyber.data.amountOut > 0n
      ? Number(
          ((selected.amountOut - kyber.data.amountOut) * 10000n) /
            kyber.data.amountOut
        )
      : null;

  // Approval spender follows the selected venue: KalqiX escrow or Kyber
  // router. The spender is part of the allowance query key, so switching
  // venue cards re-reads the right allowance automatically.
  const spender = selected?.approvalAddress ?? network.escrowContract;
  // Native ETH is paid via msg.value — no ERC-20 allowance exists, so skip the
  // allowance read entirely (balanceOf/allowance on the 0xEeee… sentinel would
  // just revert).
  const allowance = useTokenAllowance(
    inInfo.address,
    address,
    spender,
    !inInfo.isNative
  );

  const approve = useApprove();
  const createIntent = useCreateIntent();
  const deposit = useDeposit();
  const routerTx = useDeposit({
    sent: "router swap sent",
    confirmed: "router swap confirmed",
  });
  const { collectPermit } = usePermit();
  const [permitSigning, setPermitSigning] = useState(false);
  const [permitError, setPermitError] = useState<Error | null>(null);

  // Quote refresh countdown.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!selected) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [selected?.fetchedAt]);
  const secondsToRefresh = selected
    ? Math.max(0, 5 - Math.floor((Date.now() - selected.fetchedAt) / 1000))
    : null;

  // Hard staleness (QUOTE_TTL_MS from quoted_at). The 5s refresh keeps quotes
  // far inside the TTL normally — this trips only when refreshes stall (tab
  // throttling, network loss), and the guard in resolveFreshQuote makes a
  // stale submit impossible either way.
  const quoteAgeMs = selected ? Date.now() - selected.fetchedAt : null;
  const isStale = quoteAgeMs !== null && quoteAgeMs >= QUOTE_TTL_MS;
  useEffect(() => {
    if (isStale && !quote.isFetching && !isInFlight) void quote.refetch();
  }, [isStale, quote.isFetching, isInFlight]);

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
    setVenueOverride(null);
    createIntent.reset();
    deposit.reset();
    routerTx.reset();
    approve.reset();
    setPermitError(null);
    setSubmitError(null);
  }, [network.key]);

  // ---------- LIFECYCLE RECORDING ----------
  // createIntent succeeded → record + propagate intent ID up.
  useEffect(() => {
    if (createIntent.isSuccess && createIntent.data) {
      lifecycle.setIntentId(createIntent.data.id);
      const solver = createIntent.data.solver_address;
      lifecycle.recordStep({
        key: "createIntent",
        at: Date.now(),
        label: "POST /intent",
        ok: true,
        detail: solver
          ? `solver ${solver.slice(0, 6)}…${solver.slice(-4)}`
          : "kyber router",
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

  // ---------- KYBERSWAP router tx lifecycle ----------
  // No escrow, no poller: broadcast + receipt are the whole story, so the
  // lifecycle ends HERE (IntentPanel only ends KALQIX lifecycles).
  useEffect(() => {
    if (routerTx.txHash) {
      lifecycle.recordStep({
        key: "routerTx",
        at: Date.now(),
        label: "Router swap broadcast",
        ok: true,
        tx: routerTx.txHash,
      });
      setAmountInStr("");
    }
  }, [routerTx.txHash]);

  useEffect(() => {
    if (routerTx.isSuccess && routerTx.txHash) {
      const out = receiptAmountOut(routerTx.receipt, outInfo, address);
      if (out !== null) {
        lifecycle.setActualAmountOut(
          `${fmtAmount(out, outInfo.decimals)} ${outInfo.symbol}`
        );
      }
      lifecycle.recordStep({
        key: "routerConfirmed",
        at: Date.now(),
        label: "Router swap confirmed",
        ok: true,
        tx: routerTx.txHash,
      });
      lifecycle.end(Date.now());
    }
  }, [routerTx.isSuccess, routerTx.txHash]);

  // A rejected or reverted tx must not leave the lifecycle in-flight forever
  // (that would lock the swap CTA until a network switch). The inline error
  // block + activity log carry the cause.
  useEffect(() => {
    if (
      (routerTx.error || deposit.error) &&
      lifecycle.endedAt === null &&
      lifecycle.steps.length > 0
    ) {
      lifecycle.end(Date.now());
    }
  }, [routerTx.error, deposit.error]);

  // After successful terminal lifecycle, reset local mutation state so the next
  // submit starts fresh. Triggered by lifecycle.endedAt.
  useEffect(() => {
    if (lifecycle.endedAt !== null) {
      // small grace period so the UI shows terminal state before reset
      const id = setTimeout(() => {
        createIntent.reset();
        deposit.reset();
        routerTx.reset();
        approve.reset();
      }, 1500);
      return () => clearTimeout(id);
    }
  }, [lifecycle.endedAt]);

  function flip() {
    if (isInFlight) return;
    setUsdcSide((s) => (s === "in" ? "out" : "in"));
    setAmountInStr("");
    setVenueOverride(null);
    setSubmitError(null);
    createIntent.reset();
    deposit.reset();
    routerTx.reset();
  }

  function selectPaired(symbol: TokenSymbol) {
    if (isInFlight || symbol === "USDC") return;
    setPairedToken(symbol as Exclude<TokenSymbol, "USDC">);
    setAmountInStr("");
    setVenueOverride(null);
    setSubmitError(null);
    createIntent.reset();
    deposit.reset();
    routerTx.reset();
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
  // compare the venue spender's allowance against the input amount.
  const needsApprove =
    !inInfo.isNative &&
    typeof allowance.data === "bigint" &&
    amountIn > 0n
      ? (allowance.data as bigint) < amountIn
      : false;

  // When the token supports EIP-2612 and allowance is insufficient, the permit
  // signature replaces the separate approve() tx — one wallet popup for the
  // whole swap. Without permit support, we keep the two-tx fallback (approve
  // first, then confirm). The Kyber router path never takes permits — permit
  // pass-through isn't enabled for it, so it always uses plain approve.
  const usePermitFlow =
    needsApprove && inInfo.supportsPermit && selected?.venue !== "KYBERSWAP";

  function pickQuote(set: MultiQuote | null | undefined): VenueQuote | null {
    if (!set) return null;
    return (
      set.quotes.find((q) => q.venue === venueOverride) ??
      set.quotes[0] ??
      null
    );
  }

  /** Never-submit-stale invariant: refetch when the in-hand quote is older
   *  than QUOTE_TTL_MS, and never fall back to a stale set if the refetch
   *  fails. Strictest requirement is KYBERSWAP's routeSummary. */
  async function resolveFreshQuote(): Promise<VenueQuote> {
    let q = pickQuote(quote.data);
    if (!q || Date.now() - q.fetchedAt >= QUOTE_TTL_MS) {
      const fresh = await quote.refetch();
      q = pickQuote(fresh.data);
    }
    if (!q) {
      throw new Error("No live quote for the selected venue — try again.");
    }
    if (Date.now() - q.fetchedAt >= QUOTE_TTL_MS) {
      throw new Error(
        "Quote could not be refreshed — not submitting a stale quote."
      );
    }
    return q;
  }

  async function onConfirm() {
    try {
      setPermitError(null);
      setSubmitError(null);
      const q = await resolveFreshQuote();
      lifecycle.start(q.venue);
      // Benchmark snapshot for the post-settlement comparison: on multi-venue
      // envs the KYBERSWAP venue quote (even when KALQIX executes); on legacy
      // mainnet the direct-API benchmark; null on testnet.
      const kyberBench = venueEnabled(network, "KYBERSWAP")
        ? quote.data?.quotes
            .find((x) => x.venue === "KYBERSWAP")
            ?.amountOut.toString() ?? null
        : kyber.data
          ? kyber.data.amountOut.toString()
          : null;
      lifecycle.setKyberAmountOut(kyberBench);
      log({
        level: "info",
        channel: "QUOTE",
        message: `submit ${q.venue} · ${fmtAmount(q.amountIn, q.amountInDecimals)} ${tokenIn} → min ${fmtAmount(q.amountOutMin, q.amountOutDecimals)} ${tokenOut}`,
      });
      if (q.venue === "KYBERSWAP") {
        await confirmKyber(q);
      } else {
        await confirmKalqix(q);
      }
    } catch (e) {
      // createIntent / permit errors surface via their own state; submit-time
      // guards (stale quote, integrity check) via submitError.
      if (
        e instanceof Error &&
        !createIntent.error &&
        !(e instanceof AvailIntentError)
      ) {
        setSubmitError(e);
      }
      lifecycle.reset();
    }
  }

  async function confirmKalqix(q: VenueQuote) {
    let permit: string | null = null;
    if (usePermitFlow && address) {
      try {
        setPermitSigning(true);
        // 1-hour permit deadline gives wide margin over Avail's ~60s
        // server-side intent deadline. The permit lives only for this tx.
        const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
        permit = await collectPermit({
          token: inInfo,
          // The quote's approval_address (the escrow on KALQIX) — same value
          // as network.escrowContract on the legacy path.
          spender: q.approvalAddress,
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
      // KalqiX-aligned amount from the quote — may differ from the typed
      // input; permits and msg.value must match it exactly.
      amount_in: q.amountIn.toString(),
      amount_out: q.amountOutMin.toString(),
      // Optional telemetry: gross expected output, pre-slippage. Lets Avail
      // see what we quoted vs what we'll accept as a slippage floor.
      amount_out_quote: q.amountOut.toString(),
      client_intent_id: `harness-${Date.now()}`,
      permit,
      // Venue fields only exist on the multi-venue backend; the legacy
      // mainnet deployment gets the exact pre-migration body.
      ...(network.venues ? { venue: "KALQIX" as const } : {}),
    });
    // Native ETH is paid as msg.value; AvailEscrow.deposit() requires
    // msg.value == amountIn exactly (reverts InvalidMsgValue otherwise) and
    // forbids a permit. ERC-20s send 0 value and rely on permit/allowance.
    deposit.deposit({
      to: intent.contract_address,
      data: intent.encoded_calldata,
      value: inInfo.isNative ? q.amountIn : 0n,
    });
  }

  function buildKyberBody(q: VenueQuote): CreateIntentRequest {
    const rs = q.venueDetail?.routeSummary;
    // Acceptance requirement: routeSummary must reach POST /intent verbatim.
    // Deep-equality check against the parse-time snapshot catches any
    // accidental mutation between quote and submit.
    if (rs === undefined || JSON.stringify(rs) !== q.routeSummaryJson) {
      throw new Error("routeSummary integrity check failed — re-quote required.");
    }
    return {
      token_in: inInfo.address,
      token_out: outInfo.address,
      amount_in: q.amountIn.toString(),
      amount_out: q.amountOutMin.toString(),
      amount_out_quote: q.amountOut.toString(),
      client_intent_id: `harness-${Date.now()}`,
      venue: "KYBERSWAP",
      venue_detail: q.venueDetail, // same parsed reference — never rebuilt
      user_wallet: address!, // tx sender below is this same connected wallet
    };
  }

  async function confirmKyber(q: VenueQuote) {
    if (!address) throw new Error("Wallet not connected");
    let intent;
    try {
      intent = await createIntent.mutateAsync(buildKyberBody(q));
    } catch (e) {
      // BAD_VENUE_DETAIL = the backend judged the route stale/mangled.
      // Re-quote and retry exactly once with the fresh routeSummary.
      if (e instanceof AvailIntentError && e.kind === "BAD_VENUE_DETAIL") {
        log({
          level: "warn",
          channel: "API",
          message: "BAD_VENUE_DETAIL · re-quoting and retrying once",
        });
        const fresh = await quote.refetch();
        const q2 =
          fresh.data?.quotes.find((x) => x.venue === "KYBERSWAP") ?? null;
        if (!q2) throw e;
        intent = await createIntent.mutateAsync(buildKyberBody(q2));
      } else {
        throw e;
      }
    }
    // Straight to the Kyber router from the connected wallet — no escrow, no
    // solver. transaction_value covers native-in swaps.
    routerTx.deposit({
      to: intent.contract_address,
      data: intent.encoded_calldata,
      value: BigInt(intent.transaction_value ?? "0"),
    });
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
  } else if (routerTx.isPending) {
    ctaLabel = "Awaiting router swap…";
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
  } else if (network.venues && allowedVenues.length === 0) {
    ctaLabel = "Amount outside venue limits";
    ctaDisabled = true;
  } else if (quote.isFetching && !quote.data) {
    ctaLabel = "Quoting…";
    ctaDisabled = true;
    ctaShowSpinner = true;
  } else if (quote.isError) {
    ctaLabel =
      quote.error instanceof ServiceUnavailableError
        ? "Intake stopped"
        : "Quote unavailable";
    ctaDisabled = true;
  } else if (quote.data && !selected) {
    ctaLabel = "No venue available";
    ctaDisabled = true;
  } else if (isStale) {
    ctaLabel = "Quote stale — refreshing…";
    ctaDisabled = true;
    ctaShowSpinner = true;
  } else if (needsApprove && !usePermitFlow) {
    if (approve.isPending) {
      ctaLabel = "Approving…";
      ctaDisabled = true;
      ctaShowSpinner = true;
    } else {
      ctaLabel =
        selected?.venue === "KYBERSWAP"
          ? `Approve ${tokenIn} for router`
          : `Approve ${tokenIn}`;
      ctaAction = () => approve.approve(inInfo.address, spender, amountIn);
    }
  }

  const error =
    permitError ||
    submitError ||
    createIntent.error ||
    deposit.error ||
    routerTx.error ||
    approve.error;
  const formDisabled =
    isInFlight ||
    approve.isPending ||
    permitSigning ||
    !network.configured;

  // Venue comparison cards (multi-venue envs only). Stable config order.
  const venueCards: VenueCardModel[] = isMultiVenue
    ? (network.venues ?? []).map((v) => {
        const vq = quotes.find((q) => q.venue === v) ?? null;
        const failure =
          quote.data?.failures.find((f) => f.venue === v) ?? null;
        const limitReason =
          venueStates.find((s) => s.venue === v)?.reason ?? null;
        return {
          venue: v,
          quote: vq,
          failure,
          limitReason,
          isSelected: selected?.venue === v,
          isBest: quotes[0]?.venue === v && quotes.length > 0,
          ageSec: vq
            ? Math.max(0, Math.floor((Date.now() - vq.fetchedAt) / 1000))
            : null,
          isStale: vq ? Date.now() - vq.fetchedAt >= QUOTE_TTL_MS : false,
        };
      })
    : [];

  // Single-venue envs surface an all-venues-failed quote as a status line
  // (multi-venue envs show it on the cards instead).
  const venueFailure =
    !isMultiVenue && quote.data && !selected
      ? quote.data.failures[0] ?? null
      : null;

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
        ) : selected ? (
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
              selected ? fmtAmount(selected.amountOut, outInfo.decimals) : ""
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
        {isMultiVenue && amountIn > 0n ? (
          <VenueQuoteCards
            models={venueCards}
            outInfo={outInfo}
            pairedToken={pairedToken}
            onSelect={setVenueOverride}
            disabled={formDisabled}
          />
        ) : null}
        {!isMultiVenue ? (
          <div className="swap__line">
            <span>{selected?.side === "BUY" ? "Best ask" : "Best bid"}</span>
            <b className="num">
              {selected
                ? `${selected.priceHuman.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC / ${pairedToken}`
                : "—"}
            </b>
          </div>
        ) : null}
        {!isMultiVenue && selected?.takerFeeBps != null ? (
          <div className="swap__line">
            <span>Taker fee</span>
            <span className="num">
              {(selected.takerFeeBps / 100).toFixed(2)} %
            </span>
          </div>
        ) : null}
        <div className="swap__line">
          <span>Min received</span>
          <b className="num">
            {selected
              ? `${fmtAmount(selected.amountOutMin, outInfo.decimals)} ${tokenOut}`
              : "—"}
          </b>
        </div>
        {showKyberBenchmark ? (
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
              : isStale
                ? "stale — refreshing"
                : selected
                  ? `in ${secondsToRefresh ?? 0}s`
                  : "—"}
          </span>
        </div>
        {quote.isError || venueFailure ? (
          <div className="swap__line">
            <span>Status</span>
            <span className="err">
              {quote.error instanceof ServiceUnavailableError
                ? "Intake stopped — backend unavailable"
                : quote.error instanceof Error
                  ? quote.error.message
                  : venueFailure
                    ? venueFailure.message || venueFailure.code
                    : "Quote unavailable"}
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
        {selected && !ctaDisabled ? (
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
