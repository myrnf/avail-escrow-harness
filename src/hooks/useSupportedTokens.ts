import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { getSupportedTokens } from "../lib/quote/supportedTokens";
import type { Venue } from "../config/networks";
import { useActiveNetwork } from "./useActiveNetwork";

export interface LimitViolation {
  kind: "below_min" | "above_max";
  limit: bigint;
}

/**
 * Per-venue token amount limits from GET /supported-token, used to disable a
 * venue with a reason before its quote can fail. Only fetched on multi-venue
 * (v2) envs. If the endpoint fails, `violation` returns null for everything —
 * server-side venue errors take over; the app never blocks on this data.
 */
export function useSupportedTokens() {
  const network = useActiveNetwork();
  const query = useQuery({
    queryKey: ["supported-token", network.key],
    enabled: !!network.venues && network.configured,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: () => getSupportedTokens(network.availEscrowBaseUrl),
  });

  const violation = useCallback(
    (venue: Venue, token: Address, amountIn: bigint): LimitViolation | null => {
      const rows = query.data;
      if (!rows || amountIn <= 0n) return null;
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
    [query.data]
  );

  return { ...query, violation };
}
