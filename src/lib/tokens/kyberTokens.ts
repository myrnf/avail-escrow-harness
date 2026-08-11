import type { Address } from "viem";
import type { ChainToken } from "./types";

/** Kyber's token-list entry. Only the fields we consume are modelled. */
interface KyberTokenRow {
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  isStable?: boolean;
  /** "2", "1", … — the EIP-2612 domain version this token signs with. */
  permitVersion?: string;
  isHoneypot?: boolean;
  isFOT?: boolean;
  marketCap?: number;
}

/** Kyber caps pageSize server-side; 100 is the largest it accepts. */
const PAGE_SIZE = 100;

/** Chains carry a few hundred whitelisted tokens (Base: 334). Bound the walk
 *  so a pathological response can't spin — 500 is far more than any chain has
 *  today and still only 5 requests. */
const MAX_PAGES = 5;

function toChainToken(r: KyberTokenRow): ChainToken {
  return {
    chainId: r.chainId,
    address: r.address as Address,
    symbol: r.symbol,
    name: r.name,
    decimals: r.decimals,
    ...(r.logoURI ? { logoURI: r.logoURI } : {}),
    source: "kyber",
    ...(r.permitVersion ? { permitVersion: r.permitVersion } : {}),
    ...(r.isStable ? { isStable: true } : {}),
  };
}

/** Honeypots and fee-on-transfer tokens quote fine but execute badly; a
 *  harness shouldn't put them one click away. */
const usable = (r: KyberTokenRow) => !r.isHoneypot && !r.isFOT;

async function fetchTokens(params: Record<string, string>): Promise<KyberTokenRow[]> {
  const res = await fetch(
    `/kyber-tokens/api/v1/tokens?${new URLSearchParams(params)}`
  );
  // A 400 means Kyber doesn't serve this chain (Mantle). Not fatal: the
  // paste-an-address path still works, so return nothing rather than throw.
  if (!res.ok) return [];
  const body = await res.json();
  return body?.data?.tokens ?? [];
}

/**
 * Whitelisted tokens for a chain, from KyberSwap's token API via the
 * same-origin /kyber-tokens proxy (it returns
 * `access-control-allow-origin: null`, so it cannot be called directly).
 *
 * This is the browse list on every chain: its coverage is defined by the same
 * service that produces the routes, so a token here is one Kyber can quote.
 * Chain 5000 (Mantle) returns 400 — the same chain Kyber can't route — so
 * callers must tolerate an empty list.
 *
 * Paginated: the API caps a page at 100 and Base alone has 334 whitelisted
 * tokens, so fetching a single page silently truncated most major chains.
 */
export async function getKyberTokens(chainId: number): Promise<ChainToken[]> {
  const out: ChainToken[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = await fetchTokens({
      chainIds: String(chainId),
      isWhitelisted: "true",
      pageSize: String(PAGE_SIZE),
      page: String(page),
    });
    out.push(...rows.filter(usable).map(toChainToken));
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * Search Kyber's FULL token registry for a chain — not just the whitelist.
 *
 * The whitelist is a curated subset (Base: 334 of ~1,200) and it omits tokens
 * that are perfectly quotable. GHO on Base is the motivating case: not
 * whitelisted, yet it routes through quickswap-v4, and QuickSwap lists it in
 * their own UI. Without this the picker would hide tokens the harness can
 * actually trade.
 *
 * `query` matches symbol or address — the parameter name is `query`;
 * `search`/`q`/`symbol` are silently ignored by the API and return the
 * unfiltered list, which looks like a working search until you check.
 */
export async function searchKyberTokens(
  chainId: number,
  query: string
): Promise<ChainToken[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const rows = await fetchTokens({
    chainIds: String(chainId),
    query: q,
    pageSize: "20",
    page: "1",
  });
  return rows.filter(usable).map(toChainToken);
}
