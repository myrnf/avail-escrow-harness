import { KALQIX_BASE_URL } from "../../config/kalqix";
import type { KalqiXMarket, KalqiXMarketPrice, Side } from "./types";

class KalqiXError extends Error {
  constructor(message: string, public status: number, public body: string) {
    super(message);
    this.name = "KalqiXError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${KALQIX_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new KalqiXError(
      `KalqiX ${path} → ${res.status}`,
      res.status,
      text
    );
  }
  return JSON.parse(text) as T;
}

export async function getMarket(ticker: string): Promise<KalqiXMarket> {
  return request<KalqiXMarket>(`/markets/${encodeURIComponent(ticker)}`);
}

export async function getMarketPrice(
  ticker: string,
  side: Side
): Promise<KalqiXMarketPrice> {
  return request<KalqiXMarketPrice>(
    `/markets/${encodeURIComponent(ticker)}/market-price?side=${side}`
  );
}

export { KalqiXError };
