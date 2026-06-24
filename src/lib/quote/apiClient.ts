import type { Address } from "viem";

/** One venue's quote within an Avail /quote response. */
export interface AvailQuoteVenue {
  venue_name: string;
  amount_out: string | null;
  amount_out_min: string | null;
  error_code: string | null;
  error_message: string | null;
}

/** Avail GET /quote response shape. */
export interface AvailQuoteResponse {
  token_in: Address;
  token_out: Address;
  amount_in: string;
  quoted_at: number;
  quotes: AvailQuoteVenue[];
  error_code: string | null;
  error_message: string | null;
}

interface Params {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
}

/**
 * Fetch a quote from Avail's GET /quote via the same-origin /api/quote proxy.
 * The proxy is required because GET /quote takes a JSON *body*, which browsers
 * refuse to send on GET (see api/_availQuote.js). Addresses are lowercased to
 * match Avail's case-sensitive asset registry (same as the intent client).
 */
export async function getAvailQuote(
  baseUrl: string,
  { tokenIn, tokenOut, amountIn, slippageBps }: Params
): Promise<AvailQuoteResponse> {
  const res = await fetch("/api/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseUrl,
      token_in: tokenIn.toLowerCase(),
      token_out: tokenOut.toLowerCase(),
      amount_in: amountIn.toString(),
      slippage_bps: slippageBps,
    }),
  });
  const text = await res.text();
  let json: AvailQuoteResponse;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Quote proxy ${res.status}: ${text.slice(0, 160)}`);
  }
  return json;
}
