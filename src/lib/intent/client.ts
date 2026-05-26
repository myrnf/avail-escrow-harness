import type {
  CreateIntentEnvelope,
  CreateIntentRequest,
  CreateIntentSuccess,
  IntentDetail,
  IntentErrorCode,
} from "./types";

export class AvailIntentError extends Error {
  constructor(
    message: string,
    public readonly kind: IntentErrorCode | string,
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

  // 413/415/422 (payload-too-large, missing Content-Type, JSON shape doesn't
  // deserialize) return text/plain per the OpenAPI spec. Surface the body
  // text as the error message rather than parsing it as JSON.
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await res.text().catch(() => "");
    throw new AvailIntentError(
      text || `Avail Escrow returned ${res.status} with no body`,
      "INTERNAL_ERROR",
      res.status
    );
  }

  // Avail's response shape diverged between deployments. Testnet (new) returns
  // a flat object: {id, encoded_calldata, contract_address, solver_address,
  // error_code, error_message}. Canary (old) returns a wrapped envelope:
  // {success: {...}, error: {kind, message}}. Handle both until they reconcile.
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new AvailIntentError(
      `Avail Escrow returned non-JSON (HTTP ${res.status})`,
      "INTERNAL_ERROR",
      res.status
    );
  }
  if (typeof payload !== "object" || payload === null) {
    throw new AvailIntentError(
      `Avail Escrow returned non-object body (HTTP ${res.status})`,
      "INTERNAL_ERROR",
      res.status
    );
  }
  const obj = payload as Record<string, unknown>;

  // Detect the new flat shape: has top-level `error_code`/`error_message`
  // and `id`/`encoded_calldata` instead of nested `success`/`error`.
  const looksFlat =
    "error_code" in obj || "error_message" in obj ||
    (!("success" in obj) && "encoded_calldata" in obj);

  if (looksFlat) {
    const errorCode = obj.error_code as string | null | undefined;
    const errorMessage = obj.error_message as string | null | undefined;
    if (errorCode || errorMessage) {
      throw new AvailIntentError(
        errorMessage || `Avail Escrow error: ${errorCode}`,
        errorCode || "INTERNAL_ERROR",
        res.status
      );
    }
    const success: Partial<CreateIntentSuccess> = {
      id: obj.id as string,
      encoded_calldata: obj.encoded_calldata as CreateIntentSuccess["encoded_calldata"],
      contract_address: obj.contract_address as CreateIntentSuccess["contract_address"],
      solver_address: obj.solver_address as CreateIntentSuccess["solver_address"],
    };
    if (!success.id || !success.encoded_calldata) {
      throw new AvailIntentError(
        `Avail Escrow returned empty success fields (HTTP ${res.status})`,
        "INTERNAL_ERROR",
        res.status
      );
    }
    return success as CreateIntentSuccess;
  }

  // Legacy wrapped envelope (still used by canary).
  const envelope = obj as unknown as CreateIntentEnvelope;
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
