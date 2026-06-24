// Type surface for the plain-JS helper (kept as .js for the Vercel Node runtime).
export function fetchAvailQuote(
  baseUrl: string,
  payload: Record<string, unknown>
): Promise<{ status: number; body: string }>;
