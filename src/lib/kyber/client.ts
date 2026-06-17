import type { Address } from "viem";

/** Subset of the KyberSwap aggregator `routeSummary` we use as a benchmark. */
export interface KyberQuote {
  /** Estimated output in tokenOut base units. */
  amountOut: bigint;
  amountOutUsd: number;
  /** Estimated gas cost of the on-chain Kyber swap, in USD. */
  gasUsd: number;
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
  const qs = new URLSearchParams({
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
  });
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
  return {
    amountOut: BigInt(rs.amountOut),
    amountOutUsd: Number(rs.amountOutUsd),
    gasUsd: Number(rs.gasUsd),
  };
}
