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
 * Fetch a quote from Avail's GET /quote. The endpoint takes query params and
 * sends `access-control-allow-origin: *`, so we call it directly from the
 * browser — no proxy needed. Addresses are lowercased to match Avail's
 * case-sensitive asset registry (same as the intent client).
 */
export async function getAvailQuote(
  baseUrl: string,
  { tokenIn, tokenOut, amountIn, slippageBps }: Params
): Promise<AvailQuoteResponse> {
  const params = new URLSearchParams({
    token_in: tokenIn.toLowerCase(),
    token_out: tokenOut.toLowerCase(),
    amount_in: amountIn.toString(),
    slippage_bps: String(slippageBps),
  });
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/quote?${params}`);
  const text = await res.text();
  try {
    // Both success and request-level errors come back as JSON (with error_code);
    // the caller inspects error_code / quotes.
    return JSON.parse(text) as AvailQuoteResponse;
  } catch {
    throw new Error(`/quote ${res.status}: ${text.slice(0, 160)}`);
  }
}
