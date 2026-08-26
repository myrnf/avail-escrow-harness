import { useEffect, useMemo, useState } from "react";
import { isAddress } from "viem";
import type { ChainToken } from "../../lib/tokens";

interface Props {
  value: ChainToken | null;
  options: ChainToken[];
  onSelect: (token: ChainToken) => void;
  /** Resolve a pasted address on-chain. Rejects if there's no ERC-20 there. */
  onResolveAddress: (raw: string) => Promise<ChainToken>;
  /** Look up tokens beyond the curated list (Kyber's full registry). */
  onSearchRemote?: (query: string) => Promise<ChainToken[]>;
  /** Token that's selected on the other leg — shown but not selectable, since
   *  a same-token pair is never a valid swap. */
  excludeAddress?: string;
  loading?: boolean;
  /** Kyber serves no list for this chain — lead with the address field. */
  listUnavailable?: boolean;
  /** Overlap summary: how many of the options QuickSwap also lists, out of how
   *  many they list on this chain. Omitted on non-QuickSwap chains. */
  quickswapListed?: number;
  quickswapTotal?: number;
  disabled?: boolean;
}

/** First two characters of the symbol, as a stand-in when a token has no logo.
 *  Most listed tokens carry one; pasted tokens never do. */
function initials(sym: string): string {
  return sym.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

function TokenMark({ token }: { token: ChainToken }) {
  if (token.logoURI) {
    return (
      <img
        className="tk-mark tk-mark--img"
        src={token.logoURI}
        alt=""
        loading="lazy"
        aria-hidden
      />
    );
  }
  return (
    <span className="tk-mark" aria-hidden>
      {initials(token.symbol)}
    </span>
  );
}

/**
 * Token picker over the active chain's list, with search and a paste-an-address
 * escape hatch. Both legs are freely selectable — the old USDC-hub constraint
 * was a KalqiX market rule, and it doesn't apply to KyberSwap routing.
 */
export function TokenSelect({
  value,
  options,
  onSelect,
  onResolveAddress,
  onSearchRemote,
  excludeAddress,
  loading,
  listUnavailable,
  quickswapListed,
  quickswapTotal,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [remote, setRemote] = useState<ChainToken[]>([]);
  const [searching, setSearching] = useState(false);
  const [qsOnly, setQsOnly] = useState(false);

  // Guard against a stale filter: switching to a chain QuickSwap doesn't cover
  // hides the control, and without this the list would silently empty out.
  const qsFilterActive = qsOnly && !!quickswapTotal;

  const query = q.trim().toLowerCase();

  // The curated list is a subset of what Kyber can quote — GHO on Base is
  // listed by QuickSwap and routes through quickswap-v4, but isn't whitelisted.
  // Search the full registry so those are reachable, debounced so typing
  // doesn't fire a request per keystroke.
  useEffect(() => {
    if (!onSearchRemote || q.trim().length < 2) {
      setRemote([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const id = setTimeout(() => {
      onSearchRemote(q.trim())
        .then((r) => {
          if (!cancelled) setRemote(r);
        })
        .catch(() => {
          if (!cancelled) setRemote([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(id);
      setSearching(false);
    };
  }, [q, onSearchRemote]);
  const filtered = useMemo(() => {
    const pool = qsFilterActive
      ? options.filter((t) => t.quickswapListed)
      : options;
    if (!query) return pool;
    return pool.filter(
      (t) =>
        t.symbol.toLowerCase().includes(query) ||
        t.name.toLowerCase().includes(query) ||
        t.address.toLowerCase() === query
    );
  }, [options, query, qsFilterActive]);

  // Full-registry hits are outside QuickSwap's list by definition unless the
  // marker says otherwise, so the filter applies to them too.
  const remoteShown = useMemo(
    () => (qsFilterActive ? remote.filter((t) => t.quickswapListed) : remote),
    [remote, qsFilterActive]
  );

  // An address that isn't already in the list is offered as an explicit
  // "resolve this" action rather than silently returning no results.
  const pasteCandidate =
    isAddress(q.trim()) &&
    !options.some((t) => t.address.toLowerCase() === query)
      ? q.trim()
      : null;

  function close() {
    setOpen(false);
    setQ("");
    setResolveError(null);
    setRemote([]);
  }

  async function resolve(raw: string) {
    setResolving(true);
    setResolveError(null);
    try {
      const t = await onResolveAddress(raw);
      onSelect(t);
      close();
    } catch (e) {
      setResolveError(e instanceof Error ? e.message : "Could not resolve token");
    } finally {
      setResolving(false);
    }
  }

  return (
    <div className="token-select">
      <button
        className="token-pill"
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {value ? (
          <>
            <TokenMark token={value} />
            {value.symbol}
          </>
        ) : (
          <span className="token-pill__empty">Select</span>
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          stroke="currentColor"
          fill="none"
          strokeWidth="1.4"
          aria-hidden
        >
          <path d="M2 4l3 3 3-3" />
        </svg>
      </button>

      {open ? (
        <>
          <div className="token-select__backdrop" onClick={close} aria-hidden />
          <div className="token-select__menu">
            <input
              className="token-select__search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={
                listUnavailable
                  ? "Paste a token address"
                  : "Search or paste an address"
              }
              autoFocus
              spellCheck={false}
            />

            {quickswapTotal ? (
              <div
                className="token-select__filters"
                role="group"
                aria-label="Token source filter"
              >
                <button
                  type="button"
                  className={"token-select__filter" + (qsFilterActive ? "" : " is-active")}
                  aria-pressed={!qsFilterActive}
                  onClick={() => setQsOnly(false)}
                >
                  All <span className="token-select__count">{options.length}</span>
                </button>
                <button
                  type="button"
                  className={"token-select__filter" + (qsFilterActive ? " is-active" : "")}
                  aria-pressed={qsFilterActive}
                  onClick={() => setQsOnly(true)}
                  title="Only tokens in QuickSwap's own default token list"
                >
                  QuickSwap{" "}
                  <span className="token-select__count">{quickswapListed ?? 0}</span>
                </button>
              </div>
            ) : null}

            {listUnavailable && !q ? (
              <p className="token-select__note">
                No token list for this chain — paste an ERC-20 address and its
                symbol and decimals will be read on-chain.
              </p>
            ) : null}

            {pasteCandidate ? (
              <button
                type="button"
                className="token-select__opt token-select__opt--resolve"
                onClick={() => resolve(pasteCandidate)}
                disabled={resolving}
              >
                <span className="tk-mark" aria-hidden>
                  +
                </span>
                <span className="token-select__optbody">
                  <span className="token-select__sym">
                    {resolving ? "Reading contract…" : "Add this token"}
                  </span>
                  <span className="token-select__name">{pasteCandidate}</span>
                </span>
              </button>
            ) : null}

            {resolveError ? (
              <p className="token-select__error">{resolveError}</p>
            ) : null}

            {loading && !options.length ? (
              <p className="token-select__note">Loading tokens…</p>
            ) : null}

            <ul className="token-select__list" role="listbox">
              {filtered.map((opt) => {
                const isOther =
                  !!excludeAddress &&
                  opt.address.toLowerCase() === excludeAddress.toLowerCase();
                return (
                  <li key={opt.address}>
                    <button
                      type="button"
                      className="token-select__opt"
                      role="option"
                      aria-selected={
                        !!value &&
                        opt.address.toLowerCase() === value.address.toLowerCase()
                      }
                      disabled={isOther}
                      title={isOther ? "Already selected on the other leg" : opt.address}
                      onClick={() => {
                        onSelect(opt);
                        close();
                      }}
                    >
                      <TokenMark token={opt} />
                      <span className="token-select__optbody">
                        <span className="token-select__sym">{opt.symbol}</span>
                        <span className="token-select__name">{opt.name}</span>
                      </span>
                      {opt.quickswapListed ? (
                        <span
                          className="token-select__tag token-select__tag--qs"
                          title="Also listed in QuickSwap's own token list"
                        >
                          QUICKSWAP
                        </span>
                      ) : null}
                      {opt.source === "custom" ? (
                        <span className="token-select__tag">CUSTOM</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
              {remoteShown.map((opt) => (
                <li key={`remote-${opt.address}`}>
                  <button
                    type="button"
                    className="token-select__opt"
                    role="option"
                    aria-selected={false}
                    title={opt.address}
                    onClick={() => {
                      onSelect(opt);
                      close();
                    }}
                  >
                    <TokenMark token={opt} />
                    <span className="token-select__optbody">
                      <span className="token-select__sym">{opt.symbol}</span>
                      <span className="token-select__name">{opt.name}</span>
                    </span>
                    {opt.quickswapListed ? (
                      <span
                        className="token-select__tag token-select__tag--qs"
                        title="Listed by QuickSwap, but not in KyberSwap's whitelist"
                      >
                        QUICKSWAP
                      </span>
                    ) : null}
                    <span className="token-select__tag">UNLISTED</span>
                  </button>
                </li>
              ))}
              {searching ? (
                <li>
                  <p className="token-select__note">Searching all tokens…</p>
                </li>
              ) : null}
              {!filtered.length &&
              !remoteShown.length &&
              !searching &&
              !pasteCandidate &&
              !loading ? (
                <li>
                  <p className="token-select__note">
                    {qsFilterActive
                      ? "No match in QuickSwap's list — switch to All to search everything."
                      : "No matching token. Paste its address to add it."}
                  </p>
                </li>
              ) : null}
            </ul>
          </div>
        </>
      ) : null}
    </div>
  );
}
