import type { KalqiXMarket, KalqiXMarketPrice, Side } from "./types";

export class KalqiXError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string
  ) {
    super(message);
    this.name = "KalqiXError";
  }
}

async function request<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new KalqiXError(`KalqiX ${path} → ${res.status}`, res.status, text);
  }
  return JSON.parse(text) as T;
}

export async function getMarket(
  baseUrl: string,
  ticker: string
): Promise<KalqiXMarket> {
  return request<KalqiXMarket>(baseUrl, `/markets/${encodeURIComponent(ticker)}`);
}

export async function getMarketPrice(
  baseUrl: string,
  ticker: string,
  side: Side
): Promise<KalqiXMarketPrice> {
  return request<KalqiXMarketPrice>(
    baseUrl,
    `/markets/${encodeURIComponent(ticker)}/market-price?side=${side}`
  );
}
