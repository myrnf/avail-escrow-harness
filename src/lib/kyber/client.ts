import type { Address } from "viem";

/** Subset of the KyberSwap aggregator `routeSummary` we use as a benchmark. */
export interface KyberQuote {
  /** Estimated output in tokenOut base units. */
  amountOut: bigint;
  amountOutUsd: number;
  /** Estimated gas cost of the on-chain Kyber swap, in USD. */
  gasUsd: number;
}

/** A full route from the aggregator: the opaque `routeSummary` an Avail
 *  KYBERSWAP intent needs, plus the router that executes it. */
export interface KyberRoute {
  /** OPAQUE — passed to POST /intent byte-for-byte. Never re-shape it. */
  routeSummary: { routeSummary?: unknown } & Record<string, unknown>;
  /** Router the swap executes against; also the ERC-20 approval spender.
   *  Matches Avail's `approval_address` for the KYBERSWAP venue. */
  routerAddress: Address;
  amountOut: bigint;
}

async function fetchRoutes(
  chainSlug: string,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  includedSources?: string[]
): Promise<{ routeSummary: Record<string, unknown>; routerAddress: Address }> {
  const qs = new URLSearchParams({
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
  });
  if (includedSources?.length) {
    qs.set("includedSources", includedSources.join(","));
  }
  const res = await fetch(`/kyber/${chainSlug}/api/v1/routes?${qs}`, {
    headers: { "x-client-id": "avail-escrow-harness" },
  });
  if (!res.ok) {
    throw new Error(`KyberSwap ${res.status}`);
  }
  const body = await res.json();
  const rs = body?.data?.routeSummary;
  if (!rs?.amountOut) {
    throw new Error(body?.message || "KyberSwap: no route");
  }
  return { routeSummary: rs, routerAddress: body.data.routerAddress };
}

/**
 * Fetch a KyberSwap aggregator quote via the same-origin /kyber proxy
 * (vite dev proxy + Vercel rewrite — Kyber's API sends no CORS headers).
 * `chainSlug` is the Kyber chain id (e.g. "base"). Native ETH uses the same
 * 0xEeee… sentinel Kyber and Avail both recognize.
 */
export async function getKyberQuote(
  chainSlug: string,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint
): Promise<KyberQuote> {
  const { routeSummary: rs } = await fetchRoutes(
    chainSlug,
    tokenIn,
    tokenOut,
    amountIn
  );
  return {
    amountOut: BigInt(rs.amountOut as string),
    amountOutUsd: Number(rs.amountOutUsd),
    gasUsd: Number(rs.gasUsd),
  };
}

/**
 * Fetch an executable route restricted to specific aggregator sources (dex
 * ids, e.g. QuickSwap's pools). Returns the whole `routeSummary` — unlike the
 * benchmark quote above, this one is meant to be executed.
 */
export async function getKyberRoute(
  chainSlug: string,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  includedSources: string[]
): Promise<KyberRoute> {
  const { routeSummary, routerAddress } = await fetchRoutes(
    chainSlug,
    tokenIn,
    tokenOut,
    amountIn,
    includedSources
  );
  if (!routerAddress) {
    throw new Error("KyberSwap: route has no router address");
  }
  return {
    routeSummary: routeSummary as KyberRoute["routeSummary"],
    routerAddress,
    amountOut: BigInt(routeSummary.amountOut as string),
  };
}
