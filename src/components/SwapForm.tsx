import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import type { Address, Hex } from "viem";
import { Panel, PanelStatus } from "./primitives/Panel";
import { TokenSelect } from "./primitives/TokenSelect";
import { Chip } from "./primitives/Chip";
import { VenueQuoteCards, type VenueCardModel } from "./VenueQuoteCards";
import { getToken } from "../config/tokens";
import { kalqixSymbolFor } from "../config/kalqix";
import {
  DEFAULT_SLIPPAGE_BPS,
  SLIPPAGE_PRESETS_BPS,
  QUOTE_TTL_MS,
  CALLDATA_EXPIRY_MARGIN_MS,
} from "../config/avail";
import { venueEnabled, type Venue } from "../config/deployments";
import { useQuote } from "../hooks/useQuote";
import { useKyberQuote } from "../hooks/useKyberQuote";
import { useSupportedTokens } from "../hooks/useSupportedTokens";
import { useInputBalance, useTokenAllowance, useApprove } from "../hooks/useErc20";
import { useCreateIntent, useCreateIntentFromQuote } from "../hooks/useIntent";
import { useDeposit } from "../hooks/useDeposit";
import { useActiveChain, useActiveDeployment } from "../hooks/useSession";
import { useChainTokens } from "../hooks/useChainTokens";
import { nativeToken, type ChainToken } from "../lib/tokens";
import { isQuickswapChain } from "../config/chains";
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
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const publicClient = usePublicClient();
  const network = useActiveDeployment();
  const chain = useActiveChain();
  // Both legs are freely selectable. The old USDC-hub constraint was a KalqiX
  // market rule; KyberSwap routes arbitrary pairs, and KalqiX pairs are still
  // enforced by routeForAddresses returning null for anything else.
  const {
    tokens,
    isLoading: tokensLoading,
    listUnavailable,
    searchRemote,
    resolveAndAdd,
    quickswapListed: qsListedCount,
    quickswapTotal: qsTotalCount,
  } = useChainTokens();
  // Native is available synchronously on every chain, so the form always has a
  // valid input token even before the token list resolves.
  const [tokenIn, setTokenIn] = useState<ChainToken>(() => nativeToken(chain));
  const [tokenOut, setTokenOut] = useState<ChainToken | null>(null);
  const [amountInStr, setAmountInStr] = useState("");
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  /** Where executable calldata comes from. "prefetch" asks every poll for it
   *  (API v0.3.0 `create_calldata`) so confirm goes straight to the wallet;
   *  "confirm" keeps the pre-0.3.0 shape where POST /intent returns it. The
   *  variable this harness exists to measure. */
  const [calldataMode, setCalldataMode] =
    useState<"prefetch" | "confirm">("prefetch");
  // null = auto (best venue); set when the user picks a card explicitly.
  const [venueOverride, setVenueOverride] = useState<Venue | null>(null);
  // Restrict Kyber routing to QuickSwap's pools, reproducing what a
  // QuickSwap user would be quoted and execute against.
  const [quickswapOnly, setQuickswapOnly] = useState(false);
  // Submit-time failures (stale quote, integrity check) that have no
  // mutation-state channel of their own.
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const log = useActivityLog((s) => s.push);
  const lifecycle = useCurrentLifecycle();

  const inInfo = tokenIn;
  const outInfo = tokenOut;
  const isMultiVenue = (network.venues?.length ?? 0) > 1;

  // EIP-2612 only ever applies on the KalqiX path (Base), and only to the three
  // assets that deployment registers. Everything else approves normally — the
  // Kyber router takes no permits at all.
  const kalqixSymIn = kalqixSymbolFor(network, tokenIn.address);
  const permitTokenInfo =
    chain.kalqixEnabled && kalqixSymIn ? getToken(network, kalqixSymIn) : null;
  const inSupportsPermit = !!permitTokenInfo?.supportsPermit;
  // KalqiX only trades USDC-quoted pairs of its own registered assets.
  const kalqixPairSupported =
    !!tokenOut &&
    !!kalqixSymIn &&
    !!kalqixSymbolFor(network, tokenOut.address) &&
    (kalqixSymIn === "USDC") !==
      (kalqixSymbolFor(network, tokenOut.address) === "USDC");

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
  const venueStates = (network.venues ?? []).map((venue) => {
    let reason: string | null = null;
    if (venue === "KALQIX" && !chain.kalqixEnabled) {
      // KalqiX runs on Base only — the API returns no KALQIX quote elsewhere.
      reason = `not available on ${chain.label}`;
    } else if (venue === "KALQIX" && !kalqixPairSupported) {
      reason = "not a KalqiX market";
    } else {
      const violation = supported.violation(venue, inInfo.address, amountIn);
      if (violation) {
        reason = `${violation.kind === "below_min" ? "below venue min" : "above venue max"} · ${fmtAmount(violation.limit, inInfo.decimals, { minDp: 0 })} ${inInfo.symbol}`;
      }
    }
    return { venue, reason };
  });
  const allowedVenues = venueStates
    .filter((s) => !s.reason)
    .map((s) => s.venue);

  /**
   * Venues to request calldata for on every poll.
   *
   * KALQIX is excluded whenever the input token supports EIP-2612 on this
   * deployment. Its deposit calldata bakes the permit in at QUOTE time, but the
   * signature is collected after confirm — it cannot precede the thing it
   * signs. Keyed on `inSupportsPermit` rather than "does this swap need a
   * permit right now" deliberately: the allowance-dependent version flips as
   * approvals land, and each flip re-requests calldata the server has to build
   * and then retain. Better to skip pre-fetch for those tokens than to churn
   * builds we would discard.
   *
   * KYBERSWAP requires `user_wallet`, so it is unavailable until connected.
   */
  // Only testnet differs: its backend rejects 84532 and registers its Base
  // Sepolia assets under 8453, so every API call uses this while the wallet
  // transaction stays pinned to chain.id.
  const quoteChainId = network.quoteChainId ?? chain.id;

  const calldataFor = useMemo<Venue[]>(() => {
    if (calldataMode !== "prefetch" || !network.venues) return [];
    const out: Venue[] = [];
    if (!inSupportsPermit) out.push("KALQIX");
    if (address) out.push("KYBERSWAP");
    return out;
  }, [calldataMode, network.venues, inSupportsPermit, address]);

  const quote = useQuote({
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    venues: network.venues ? allowedVenues : undefined,
    quickswapOnly,
    enabled: amountIn > 0n && !isInFlight,
    calldataFor,
    userWallet: address,
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
    !!chain.kyberSlug && !venueEnabled(network, "KYBERSWAP");
  // QuickSwap-only routing needs Kyber coverage plus known QS dex ids on the
  // SELECTED CHAIN — QuickSwap routes via Kyber on Polygon and Base only.
  const qsRoutingAvailable =
    venueEnabled(network, "KYBERSWAP") &&
    !!chain.kyberSlug &&
    isQuickswapChain(chain);
  // Open-routing benchmark, fetched only while the QuickSwap restriction is on.
  // The delta between the two is the number this harness exists to produce for
  // QuickSwap: what routing exclusively through their own pools costs — or, on
  // some pairs, gains. Polled slower than the primary quote; it's a reference,
  // not the quote being executed.
  const openQuote = useQuote({
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    venues: ["KYBERSWAP"],
    quickswapOnly: false,
    enabled:
      quickswapOnly && qsRoutingAvailable && amountIn > 0n && !isInFlight,
    refreshMs: 15_000,
  });
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

  // Positive = QuickSwap-only routing is WORSE than open Kyber routing, in bps.
  const qsCostBps = (() => {
    if (!quickswapOnly || !qsRoutingAvailable) return null;
    const restricted = quotes.find((q) => q.venue === "KYBERSWAP");
    const open = openQuote.data?.quotes.find((q) => q.venue === "KYBERSWAP");
    if (!restricted || !open || open.amountOut === 0n) return null;
    return Number(
      ((open.amountOut - restricted.amountOut) * 10_000n) / open.amountOut
    );
  })();

  // Approval spender follows the selected venue: KalqiX escrow or Kyber
  // router. The spender is part of the allowance query key, so switching
  // venue cards re-reads the right allowance automatically.
  // Falling back to the escrow is only valid where KalqiX actually runs
  // (Base). On any other chain that address is meaningless, so approving it
  // would burn gas granting allowance to nothing — leave the spender null and
  // let the CTA block instead.
  const spender =
    selected?.approvalAddress ??
    (chain.kalqixEnabled ? network.escrowContract : undefined);
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
  const intentFromQuote = useCreateIntentFromQuote();
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

  // Calldata's own clock, recomputed on the same 1s tick as the refresh
  // countdown. Surfaced only when pre-fetch is on AND calldata is actually
  // held: it is the one piece of state that can invalidate a confirm while the
  // price still looks perfectly fresh.
  const showCalldataClock =
    calldataMode === "prefetch" && !!selected?.calldata;
  const calldataSecondsLeft = selected?.calldata
    ? Math.max(
        0,
        Math.floor((selected.calldata.expires_at_ms - Date.now()) / 1000)
      )
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

  // Reset local form + mutation state when the deployment OR chain changes —
  // token addresses and the escrow contract are both scoped to them, so a
  // carried-over selection would submit an address from the wrong chain. The
  // lifecycle store is keyed separately and preserves its own history.
  useEffect(() => {
    setAmountInStr("");
    setVenueOverride(null);
    createIntent.reset();
    deposit.reset();
    routerTx.reset();
    approve.reset();
    setPermitError(null);
    setSubmitError(null);
  }, [network.key, chain.id]);

  // Re-seed the pair on every chain change. Native is available synchronously,
  // so the input leg is never empty; the output leg waits for the token list.
  useEffect(() => {
    setTokenIn(nativeToken(chain));
    setTokenOut(null);
  }, [chain.id]);

  // Belt and braces on the above: a token record carries the chain it came
  // from, and one surviving a switch would send a foreign address with this
  // chain's chain_id — a wrong-chain quote that looks valid. Cheap to assert.
  useEffect(() => {
    if (tokenIn.chainId !== chain.id) setTokenIn(nativeToken(chain));
    if (tokenOut && tokenOut.chainId !== chain.id) setTokenOut(null);
  }, [chain, tokenIn, tokenOut]);

  // Fill the output leg once the list arrives — a stablecoin if there is one,
  // which is the pair a tester almost always wants and gives every chain a
  // working default without hand-curating one per chain.
  //
  // This also enforces the invariant that the two legs are never the same
  // token. On a chain switch the input is re-seeded to native and the output is
  // cleared, but those land across separate renders while the token list is
  // also being replaced; if the output ever ends up equal to the input the pair
  // can't be quoted at all, and the UI shows two identical pills with no
  // explanation. Re-picking is cheap and correct however that state arose.
  useEffect(() => {
    if (!tokens.length) return;
    const clashes =
      !!tokenOut &&
      tokenOut.address.toLowerCase() === tokenIn.address.toLowerCase();
    if (tokenOut && !clashes) return;
    const usable = tokens.filter(
      (t) => t.address.toLowerCase() !== tokenIn.address.toLowerCase()
    );
    const pick =
      usable.find((t) => t.isStable) ?? usable.find((t) => !t.isNative) ?? usable[0];
    if (pick) setTokenOut(pick);
  }, [tokens, tokenIn, tokenOut]);

  // Adopt the enriched entry once the token list resolves. A selection made
  // before the list loaded — notably the synchronous native default — holds a
  // bare record with no logo or permit metadata, while the merged list has the
  // filled-in one. Without this the pill shows the initials fallback until the
  // user reselects the same token, which is exactly what it looks like: a bug.
  useEffect(() => {
    if (!tokens.length) return;
    const enrich = (t: ChainToken | null) => {
      // Addresses repeat across chains (WETH is 0x4200…0006 on both Base and
      // Optimism), so match on chain too or a stale record can be "enriched"
      // into looking current.
      if (!t || t.chainId !== chain.id) return null;
      const found = tokens.find(
        (x) => x.address.toLowerCase() === t.address.toLowerCase()
      );
      // Only swap when it actually adds something, so this can't churn state.
      return found && found !== t && (found.logoURI ?? "") !== (t.logoURI ?? "")
        ? found
        : null;
    };
    const nextIn = enrich(tokenIn);
    if (nextIn) setTokenIn(nextIn);
    const nextOut = enrich(tokenOut);
    if (nextOut) setTokenOut(nextOut);
  }, [tokens, tokenIn, tokenOut, chain.id]);

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

  // Quote-consuming POST /intent returned. Recorded under the same step key as
  // the payload form so both modes produce directly comparable timelines —
  // the difference being that this one resolves after the wallet is already
  // open, rather than blocking it.
  useEffect(() => {
    if (intentFromQuote.isSuccess && intentFromQuote.data) {
      lifecycle.setIntentId(intentFromQuote.data.id);
      lifecycle.recordStep({
        key: "createIntent",
        at: Date.now(),
        label: "POST /intent (quote_id)",
        ok: true,
        detail: "in parallel with wallet tx",
      });
    }
  }, [intentFromQuote.isSuccess, intentFromQuote.data?.id]);

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
      const out = outInfo
        ? receiptAmountOut(routerTx.receipt, outInfo, address)
        : null;
      if (out !== null && outInfo) {
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

  /** Any change to the pair invalidates the amount, the venue choice and any
   *  in-hand quote — clear them together rather than leaving a stale mix. */
  function resetForPairChange() {
    setAmountInStr("");
    setVenueOverride(null);
    setSubmitError(null);
    createIntent.reset();
    deposit.reset();
    routerTx.reset();
  }

  function flip() {
    if (isInFlight || !tokenOut) return;
    const prevIn = tokenIn;
    setTokenIn(tokenOut);
    setTokenOut(prevIn);
    resetForPairChange();
  }

  function selectTokenIn(t: ChainToken) {
    if (isInFlight) return;
    // Picking the token already on the other leg swaps them instead of
    // producing an invalid same-token pair.
    if (tokenOut && t.address.toLowerCase() === tokenOut.address.toLowerCase()) {
      setTokenOut(tokenIn);
    }
    setTokenIn(t);
    resetForPairChange();
  }

  function selectTokenOut(t: ChainToken) {
    if (isInFlight) return;
    if (t.address.toLowerCase() === tokenIn.address.toLowerCase()) {
      setTokenIn(tokenOut ?? nativeToken(chain));
    }
    setTokenOut(t);
    resetForPairChange();
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
    needsApprove && inSupportsPermit && selected?.venue !== "KYBERSWAP";

  function pickQuote(set: MultiQuote | null | undefined): VenueQuote | null {
    if (!set) return null;
    return (
      set.quotes.find((q) => q.venue === venueOverride) ??
      set.quotes[0] ??
      null
    );
  }

  /** Calldata carries its own expiry, independent of quote staleness — a
   *  backgrounded tab can hold a quote that still looks fresh whose calldata
   *  has lapsed. Usable means present, bound to a quote we can consume, and
   *  with margin left on that clock. */
  function calldataUsable(q: VenueQuote | null | undefined): boolean {
    return (
      !!q?.calldata &&
      !!q.quoteId &&
      Date.now() < q.calldata.expires_at_ms - CALLDATA_EXPIRY_MARGIN_MS
    );
  }

  /** Whether this venue's confirm should go straight to the wallet. KALQIX
   *  falls back whenever a permit is in play: that calldata was built without
   *  one, because the signature cannot precede the thing it signs. */
  function willUsePrefetched(q: VenueQuote): boolean {
    if (!calldataFor.includes(q.venue)) return false;
    if (q.venue === "KALQIX" && usePermitFlow) return false;
    return calldataUsable(q);
  }

  /** Never-submit-stale invariant: refetch when the in-hand quote is older
   *  than QUOTE_TTL_MS, and never fall back to a stale set if the refetch
   *  fails. Strictest requirement is KYBERSWAP's routeSummary.
   *
   *  In pre-fetch mode lapsed calldata counts as stale too, so an expired
   *  window re-quotes rather than silently degrading to the slower path. */
  async function resolveFreshQuote(): Promise<VenueQuote> {
    let q = pickQuote(quote.data);
    const wantsCalldata =
      !!q &&
      calldataFor.includes(q.venue) &&
      !(q.venue === "KALQIX" && usePermitFlow);
    if (
      !q ||
      Date.now() - q.fetchedAt >= QUOTE_TTL_MS ||
      (wantsCalldata && !calldataUsable(q))
    ) {
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
        message: `submit ${q.venue} · ${fmtAmount(q.amountIn, q.amountInDecimals)} ${inInfo.symbol} → min ${fmtAmount(q.amountOutMin, q.amountOutDecimals)} ${outInfo?.symbol ?? "?"}`,
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

  /** Timeline marker for a confirm that needed no pre-wallet round-trip. Sits
   *  where "POST /intent" sits on the slow path, so the two are comparable. */
  function recordPrefetchStep(q: VenueQuote) {
    const left = Math.round((q.calldata!.expires_at_ms - Date.now()) / 1000);
    lifecycle.recordStep({
      key: "calldata",
      at: Date.now(),
      label: "Calldata pre-fetched with quote",
      ok: true,
      detail: `expires in ${left}s`,
    });
  }

  /**
   * Fire the quote-consuming POST /intent alongside the wallet transaction.
   *
   * Deliberately not awaited: we already hold the calldata, so the only thing
   * this response adds is the intent id for lifecycle polling. Awaiting it
   * would reintroduce exactly the round-trip pre-fetching removes.
   *
   * A rejection therefore does NOT fail the swap — but it is a
   * recoverable-and-silent failure, so it is logged loudly with the quote_id
   * that identifies the reserved intent. On KALQIX a deposit whose intent never
   * persisted unlocks back to the depositor after expiry; this line is how
   * you'd know to expect that rather than a settlement.
   */
  function persistIntentInParallel(q: VenueQuote) {
    intentFromQuote
      .mutateAsync({
        quote_id: q.quoteId!,
        venue: q.venue,
        client_intent_id: `harness-${Date.now()}`,
      })
      .catch((e: Error) => {
        log({
          level: "err",
          channel: "API",
          message: `POST /intent (quote_id) failed · ${q.venue} · ${e.message}`,
          details:
            q.venue === "KALQIX"
              ? `quote_id ${q.quoteId} · if the deposit landed it has no persisted intent and unlocks to the depositor after expiry`
              : `quote_id ${q.quoteId} · router swap is unaffected; only the intent record is missing`,
        });
      });
  }

  async function confirmKalqix(q: VenueQuote) {
    // Pre-fetched: calldata is already in hand, so the wallet opens with no
    // server round-trip and POST /intent runs alongside it.
    if (willUsePrefetched(q)) {
      const cd = q.calldata!;
      recordPrefetchStep(q);
      persistIntentInParallel(q);
      deposit.deposit({
        to: cd.contract_address,
        data: cd.encoded_calldata,
        value: inInfo.isNative ? q.amountIn : 0n,
      });
      return;
    }

    let permit: string | null = null;
    if (usePermitFlow && address) {
      try {
        setPermitSigning(true);
        // 1-hour permit deadline gives wide margin over Avail's ~60s
        // server-side intent deadline. The permit lives only for this tx.
        const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
        permit = await collectPermit({
          token: permitTokenInfo!,
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
      // Multi-venue backends only: the legacy deployment predates chain_id and
      // is pinned to Base, so sending it there risks a reject for no gain.
      ...(network.venues ? { chain_id: quoteChainId } : {}),
      token_in: inInfo.address,
      token_out: outInfo!.address,
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
    const rs = q.executionContext?.routeSummary;
    // Acceptance requirement: routeSummary must reach POST /intent verbatim.
    // Deep-equality check against the parse-time snapshot catches any
    // accidental mutation between quote and submit.
    if (rs === undefined || JSON.stringify(rs) !== q.routeSummaryJson) {
      throw new Error("routeSummary integrity check failed — re-quote required.");
    }
    // The API requires execution_context.chainId === chain_id for KYBERSWAP.
    // If a quote from a previous chain survived a switch, this catches it
    // before we build a transaction against the wrong network. Compared
    // against quoteChainId, not chain.id — on testnet those differ by design.
    const ctxChainId = q.executionContext?.chainId;
    if (ctxChainId !== undefined && ctxChainId !== quoteChainId) {
      throw new Error(
        `Quote is for chain ${ctxChainId}, not ${chain.label} — re-quote required.`
      );
    }
    return {
      chain_id: quoteChainId,
      token_in: inInfo.address,
      token_out: outInfo!.address,
      amount_in: q.amountIn.toString(),
      amount_out: q.amountOutMin.toString(),
      amount_out_quote: q.amountOut.toString(),
      client_intent_id: `harness-${Date.now()}`,
      venue: "KYBERSWAP",
      execution_context: q.executionContext, // same parsed reference — never rebuilt
      user_wallet: address!, // tx sender below is this same connected wallet
    };
  }

  /**
   * Gas limit for an aggregator router call: the larger of our own estimate and
   * the route's own hint, then padded.
   *
   * A bare eth_estimateGas is NOT enough here. Measured case (Base, AAVE→USDC,
   * tx 0x18892e4e…): the wallet sent 1,661,865 and the call reverted with
   * KyberSwap's generic "Call failed" after consuming 97% of it; the identical
   * calldata succeeds at 2,500,000. The router forwards only 63/64 of remaining
   * gas to each executor, so an estimate that exactly covers the top-level call
   * leaves an inner hop short, and the router reports that as a call failure
   * rather than an out-of-gas. The route's own `gas` hint was lower still.
   *
   * Unused gas is refunded, so padding costs nothing but a higher displayed max.
   */
  const GAS_BUFFER_NUM = 8n; // ×1.6
  const GAS_BUFFER_DEN = 5n;

  async function routerGasLimit(
    to: Address,
    data: Hex,
    value: bigint,
    routeHint: bigint
  ): Promise<bigint | undefined> {
    try {
      const est = publicClient
        ? await publicClient.estimateGas({ account: address, to, data, value })
        : 0n;
      const base = est > routeHint ? est : routeHint;
      if (base === 0n) return undefined;
      return (base * GAS_BUFFER_NUM) / GAS_BUFFER_DEN;
    } catch {
      // Estimation reverting usually means the swap itself would fail; let the
      // wallet estimate and surface its own error rather than forcing a limit.
      return undefined;
    }
  }

  /** The route's own gas hint, read off the opaque routeSummary. */
  function routeGasHint(q: VenueQuote): bigint {
    const rs = (q.executionContext?.routeSummary ?? null) as {
      gas?: number | string;
    } | null;
    return BigInt(rs?.gas ?? 0);
  }

  async function confirmKyber(q: VenueQuote) {
    if (!address) throw new Error("Wallet not connected");
    // Pre-fetched: straight to the router. The estimateGas below is now the
    // only pre-wallet round-trip left on this path.
    if (willUsePrefetched(q)) {
      const cd = q.calldata!;
      const value = BigInt(cd.transaction_value ?? "0");
      recordPrefetchStep(q);
      persistIntentInParallel(q);
      const gas = await routerGasLimit(
        cd.contract_address,
        cd.encoded_calldata,
        value,
        routeGasHint(q)
      );
      routerTx.deposit({
        to: cd.contract_address,
        data: cd.encoded_calldata,
        value,
        ...(gas ? { gas } : {}),
      });
      return;
    }
    let intent;
    try {
      intent = await createIntent.mutateAsync(buildKyberBody(q));
    } catch (e) {
      // BAD_EXECUTION_CONTEXT = the backend judged the route stale/mangled.
      // Re-quote and retry exactly once with the fresh routeSummary.
      if (e instanceof AvailIntentError && e.kind === "BAD_EXECUTION_CONTEXT") {
        log({
          level: "warn",
          channel: "API",
          message: "BAD_EXECUTION_CONTEXT · re-quoting and retrying once",
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
    const value = BigInt(intent.transaction_value ?? "0");
    const gas = await routerGasLimit(
      intent.contract_address,
      intent.encoded_calldata,
      value,
      routeGasHint(q)
    );
    routerTx.deposit({
      to: intent.contract_address,
      data: intent.encoded_calldata,
      value,
      ...(gas ? { gas } : {}),
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
  } else if (walletChainId !== undefined && walletChainId !== chain.id) {
    // Calldata is built for the selected chain. wagmi would also throw on
    // broadcast, but blocking here keeps the user from signing a permit or an
    // approval that targets the wrong network.
    ctaLabel = `Switch wallet to ${chain.label}`;
    ctaDisabled = true;
  } else if (!outInfo) {
    ctaLabel = "Select a token to receive";
    ctaDisabled = true;
  } else if (
    outInfo.address.toLowerCase() === inInfo.address.toLowerCase()
  ) {
    ctaLabel = "Select two different tokens";
    ctaDisabled = true;
  } else if (!spender) {
    // Only reachable once a venue quoted but returned no approval_address.
    ctaLabel = "No approval address for this venue";
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
    ctaLabel = `Insufficient ${inInfo.symbol}`;
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
          ? `Approve ${inInfo.symbol} for router`
          : `Approve ${inInfo.symbol}`;
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
          note:
            v === "KALQIX"
              ? "net of KalqiX taker fee"
              : quickswapOnly && qsRoutingAvailable
                ? "QuickSwap pools only"
                : null,
          // In flight AND nothing resolved for this venue yet. A venue that
          // already has a quote or a failure keeps showing it through the 5s
          // refresh rather than flickering back to a skeleton.
          isLoading: quote.isFetching && !vq && !failure && !limitReason,
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
            {inInfo.symbol}
            {isConnected && balance.data !== undefined && !formDisabled ? (
              <button className="max" type="button" onClick={setMax}>
                MAX
              </button>
            ) : null}
          </div>
        </div>
        <TokenSelect
          value={inInfo}
          options={tokens}
          onSelect={selectTokenIn}
          onResolveAddress={resolveAndAdd}
          onSearchRemote={searchRemote}
          excludeAddress={outInfo?.address}
          loading={tokensLoading}
          listUnavailable={listUnavailable}
          quickswapListed={qsListedCount}
          quickswapTotal={qsTotalCount}
          disabled={formDisabled}
        />
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
              selected && outInfo
                ? fmtAmount(selected.amountOut, outInfo.decimals)
                : ""
            }
            placeholder="0.00"
            readOnly
            disabled={formDisabled}
          />
          <div className="swap__balance">
            Balance — <span style={{ marginLeft: 4 }}>{outInfo?.symbol ?? "—"}</span>
          </div>
        </div>
        <TokenSelect
          value={outInfo}
          options={tokens}
          onSelect={selectTokenOut}
          onResolveAddress={resolveAndAdd}
          onSearchRemote={searchRemote}
          excludeAddress={inInfo.address}
          loading={tokensLoading}
          listUnavailable={listUnavailable}
          quickswapListed={qsListedCount}
          quickswapTotal={qsTotalCount}
          disabled={formDisabled}
        />
      </div>

      {/* Details */}
      <div className="swap__details">
        {isMultiVenue && amountIn > 0n ? (
          <VenueQuoteCards
            models={venueCards}
            outInfo={outInfo}
            onSelect={setVenueOverride}
            disabled={formDisabled}
          />
        ) : null}
        {!isMultiVenue ? (
          <div className="swap__line">
            <span>{selected?.side === "BUY" ? "Best ask" : "Best bid"}</span>
            <b className="num">
              {selected && outInfo
                ? `${selected.priceHuman.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${inInfo.symbol} / ${outInfo.symbol}`
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
            {selected && outInfo
              ? `${fmtAmount(selected.amountOutMin, outInfo.decimals)} ${outInfo.symbol}`
              : "—"}
          </b>
        </div>
        {showKyberBenchmark ? (
          <div className="swap__line">
            <span>Kyberswap est.</span>
            {kyber.data && outInfo ? (
              <span className="num">
                {fmtAmount(kyber.data.amountOut, outInfo.decimals)} {outInfo.symbol}
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
        {quickswapOnly && qsRoutingAvailable ? (
          <div className="swap__line">
            <span>QuickSwap-only vs open routing</span>
            {qsCostBps !== null ? (
              <b className={`num swap__dev ${qsCostBps <= 0 ? "is-better" : "is-worse"}`}>
                {qsCostBps <= 0 ? "+" : "−"}
                {(Math.abs(qsCostBps) / 100).toFixed(2)}%{" "}
                {qsCostBps <= 0 ? "better" : "cost"}
              </b>
            ) : openQuote.isError ? (
              <span className="err">benchmark unavailable</span>
            ) : (
              <span className="num">…</span>
            )}
          </div>
        ) : null}
        {showCalldataClock ? (
          <div className="swap__line">
            <span>Calldata expires</span>
            <span className="num">
              {calldataSecondsLeft && calldataSecondsLeft > 0
                ? `in ${calldataSecondsLeft}s`
                : "expired — re-quoting"}
            </span>
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

      {/* Routing restriction — reproduces the QuickSwap quote + flow */}
      {qsRoutingAvailable ? (
        <div className="swap__slip">
          <span className="swap__slip-label">Routing</span>
          <Chip
            active={quickswapOnly}
            onClick={() => !formDisabled && setQuickswapOnly((v) => !v)}
          >
            QuickSwap pools only
          </Chip>
        </div>
      ) : null}

      {/* Calldata source — the variable this harness exists to measure.
          "every quote" pre-fetches executable calldata on every poll so confirm
          goes straight to the wallet with no server round-trip; "on confirm"
          is the older shape where POST /intent returns it. The legacy mainnet
          backend has no calldata-on-quote, so it isn't offered there. */}
      {network.venues ? (
        <div className="swap__slip">
          <span className="swap__slip-label">Calldata</span>
          <Chip
            active={calldataMode === "prefetch"}
            onClick={() => !formDisabled && setCalldataMode("prefetch")}
          >
            every quote
          </Chip>
          <Chip
            active={calldataMode === "confirm"}
            onClick={() => !formDisabled && setCalldataMode("confirm")}
          >
            on confirm
          </Chip>
        </div>
      ) : null}

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
