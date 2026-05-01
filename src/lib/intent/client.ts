import { AVAIL_ESCROW_BASE_URL } from "../../config/avail";
import type {
  CreateIntentEnvelope,
  CreateIntentRequest,
  CreateIntentSuccess,
  IntentDetail,
} from "./types";

export class AvailIntentError extends Error {
  constructor(
    message: string,
    public readonly kind: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "AvailIntentError";
  }
}

export async function createIntent(
  body: CreateIntentRequest
): Promise<CreateIntentSuccess> {
  const res = await fetch(`${AVAIL_ESCROW_BASE_URL}/intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let envelope: CreateIntentEnvelope;
  try {
    envelope = (await res.json()) as CreateIntentEnvelope;
  } catch {
    throw new AvailIntentError(
      `Avail Escrow returned non-JSON (HTTP ${res.status})`,
      "INTERNAL_ERROR",
      res.status
    );
  }

  if (envelope.error) {
    throw new AvailIntentError(
      envelope.error.message,
      envelope.error.kind,
      res.status
    );
  }
  if (!envelope.success) {
    throw new AvailIntentError(
      `Avail Escrow returned no success payload (HTTP ${res.status})`,
      "INTERNAL_ERROR",
      res.status
    );
  }
  return envelope.success;
}

export async function getIntent(id: string): Promise<IntentDetail | null> {
  const res = await fetch(
    `${AVAIL_ESCROW_BASE_URL}/intent/${encodeURIComponent(id)}`
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new AvailIntentError(
      `GET /intent/${id} → ${res.status}`,
      "INTERNAL_ERROR",
      res.status
    );
  }
  const body = await res.json();
  if (body === null) return null;
  return body as IntentDetail;
}
