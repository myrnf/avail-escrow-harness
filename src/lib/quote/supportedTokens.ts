import type { Address } from "viem";

/** One (token, venue) row from GET /supported-token. The same token can
 *  appear once per venue with different limits; null bounds mean unbounded.
 *  A missing (token, venue) row means "no limits known" — never a violation
 *  (the live backend currently returns KALQIX rows only, even on canary). */
export interface SupportedTokenLimit {
  token_address: Address;
  venue_name: string;
  amount_min: string | null;
  amount_max: string | null;
}

export async function getSupportedTokens(
  baseUrl: string
): Promise<SupportedTokenLimit[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/supported-token`);
  if (!res.ok) {
    throw new Error(`/supported-token → ${res.status}`);
  }
  const body = (await res.json()) as SupportedTokenLimit[];
  return Array.isArray(body) ? body : [];
}
