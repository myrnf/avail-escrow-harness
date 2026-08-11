import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { getSupportedTokens } from "../lib/quote/supportedTokens";
import type { Venue } from "../config/deployments";
import { useActiveChain, useActiveDeployment } from "./useSession";

export interface LimitViolation {
  kind: "below_min" | "above_max";
  limit: bigint;
}

/**
 * Per-venue token amount limits from GET /supported-token, used to disable a
 * venue with a reason before its quote can fail. If the endpoint fails,
 * `violation` returns null for everything — server-side venue errors take over;
 * the app never blocks on this data.
 *
 * KALQIX ONLY, and only on the deployment's KalqiX chain (Base). Two reasons,
 * both measured against canary on 2026-08-11:
 *
 * 1. The KYBERSWAP rows are INERT. The endpoint advertises `0xEeee… /
 *    KYBERSWAP / min 5e15 / max 5e18`, but ETH→USDC quotes fine at 0.001 ETH
 *    (below the min) and at 500 ETH — 100x the max. KALQIX rows, by contrast,
 *    are enforced: the same boundaries return MIN_TRADE_VIOLATION and
 *    MAX_TRADE_VIOLATION. This matches the spec, which says the list "controls
 *    KALQIX eligibility" and that KYBERSWAP support is discovered dynamically.
 *    Enforcing the KYBERSWAP rows client-side only ever blocks valid trades.
 *
 * 2. The response has NO chain dimension — every row is a bare
 *    (token_address, venue_name) pair describing one chain. The native sentinel
 *    0xEeee… is byte-identical everywhere, so the Base row was read as
 *    "max 5 POL" on Polygon and excluded the venue outright, leaving no quote.
 */
export function useSupportedTokens() {
  const network = useActiveDeployment();
  const chain = useActiveChain();
  // Only the KalqiX-enabled chain is the one these rows describe.
  const applies = chain.kalqixEnabled;
  const query = useQuery({
    queryKey: ["supported-token", network.key],
    enabled: !!network.venues && network.configured && applies,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: () => getSupportedTokens(network.availEscrowBaseUrl),
  });

  const violation = useCallback(
    (venue: Venue, token: Address, amountIn: bigint): LimitViolation | null => {
      const rows = query.data;
      // KYBERSWAP rows exist in the response but are not enforced server-side;
      // honouring them here would reject trades the API accepts.
      if (venue !== "KALQIX") return null;
      if (!applies || !rows || amountIn <= 0n) return null;
      const lower = token.toLowerCase();
      const row = rows.find(
        (r) =>
          r.venue_name === venue && r.token_address.toLowerCase() === lower
      );
      // Missing (token, venue) row = no limits known — never a violation.
      if (!row) return null;
      if (row.amount_min && amountIn < BigInt(row.amount_min)) {
        return { kind: "below_min", limit: BigInt(row.amount_min) };
      }
      if (row.amount_max && amountIn > BigInt(row.amount_max)) {
        return { kind: "above_max", limit: BigInt(row.amount_max) };
      }
      return null;
    },
    [query.data, applies]
  );

  return { ...query, violation };
}
