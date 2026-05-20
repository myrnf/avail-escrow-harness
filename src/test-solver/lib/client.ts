import type { Address, Hex } from "viem";
import type { Swap, SwapRequestBody, SwapRequestResponse } from "./types";

const BASE_URL =
  import.meta.env.VITE_TEST_SOLVER_URL || "http://localhost:3000";

export class TestSolverError extends Error {
  constructor(message: string, public kind: string, public status: number) {
    super(message);
    this.name = "TestSolverError";
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { method: string }
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    try {
      const body = JSON.parse(text) as { error?: { kind: string; message: string } };
      const err = body.error;
      if (err) {
        throw new TestSolverError(err.message, err.kind, res.status);
      }
    } catch (e) {
      if (e instanceof TestSolverError) throw e;
    }
    throw new TestSolverError(
      `${init.method} ${path} → ${res.status}: ${text || "(no body)"}`,
      "UNKNOWN",
      res.status
    );
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export async function createSwapRequest(
  body: SwapRequestBody
): Promise<SwapRequestResponse> {
  return request<SwapRequestResponse>("/swap-request", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function notifyDeposit(
  swapId: string,
  txHash: Hex
): Promise<Swap> {
  return request<Swap>(`/swap/${encodeURIComponent(swapId)}/deposit-tx`, {
    method: "POST",
    body: JSON.stringify({ tx_hash: txHash }),
  });
}

export async function getSwap(swapId: string): Promise<Swap> {
  return request<Swap>(`/swap/${encodeURIComponent(swapId)}`, {
    method: "GET",
  });
}

export interface Health {
  status: string;
  market: string;
  solver: Address;
  inventory: {
    solver: Address;
    usdc_eoa: string | null;
    cbbtc_eoa: string | null;
  };
}

export async function getHealth(): Promise<Health> {
  return request<Health>("/health", { method: "GET" });
}
