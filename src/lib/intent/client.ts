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
  baseUrl: string,
  body: CreateIntentRequest
): Promise<CreateIntentSuccess> {
  if (!baseUrl) {
    throw new AvailIntentError(
      "Avail Escrow base URL is not configured for the active network.",
      "INTERNAL_ERROR",
      0
    );
  }
  // Avail's API is case-sensitive on its asset registry — checksummed addresses
  // produce "No asset was found for the 'token_in' field." Normalize to lower.
  const normalized: CreateIntentRequest = {
    ...body,
    token_in: body.token_in.toLowerCase() as typeof body.token_in,
    token_out: body.token_out.toLowerCase() as typeof body.token_out,
  };
  const res = await fetch(`${baseUrl}/intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(normalized),
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

export async function getIntent(
  baseUrl: string,
  id: string
): Promise<IntentDetail | null> {
  if (!baseUrl) return null;
  const res = await fetch(
    `${baseUrl}/intent/${encodeURIComponent(id)}`
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
