import { useQuery, useMutation } from "@tanstack/react-query";
import {
  createIntent,
  createIntentFromQuote,
  getIntent,
  getIntentV2,
  viewFromV1,
  viewFromV2,
  type CreateIntentFromQuoteRequest,
  type CreateIntentRequest,
  type IntentStatusView,
} from "../lib/intent";
import { shortAddress } from "../lib/format";
import { useActivityLog } from "../store/activityLog";
import { useActiveDeployment } from "./useSession";

// Intent status polling cadence while in-flight. 500ms keeps the
// harness's per-phase timings tight enough to be useful as actual
// latency measurements — combined polling jitter on fill + settled
// transitions is bounded to ~1s instead of 5s.
const POLL_MS = 500;

export function useCreateIntent() {
  const log = useActivityLog((s) => s.push);
  const network = useActiveDeployment();
  return useMutation({
    mutationFn: async (body: CreateIntentRequest) => {
      const t0 = performance.now();
      const success = await createIntent(network.availEscrowBaseUrl, body);
      const dt = Math.round(performance.now() - t0);
      // KYBERSWAP intents have no solver; surface the router value instead.
      const tail = success.solver_address
        ? `solver ${shortAddress(success.solver_address)}`
        : `value ${success.transaction_value ?? "0"}`;
      log({
        level: "info",
        channel: "API",
        message: `POST /intent · 200 · ${tail}`,
        details: `${dt}ms`,
      });
      return success;
    },
    onError: (err: Error) => {
      log({
        level: "err",
        channel: "API",
        message: `POST /intent failed · ${err.message}`,
      });
    },
  });
}

/**
 * Quote-consuming POST /intent: persists the intent whose calldata the poll
 * loop already handed us.
 *
 * Deliberately has NO onError. This call is fired in parallel with the wallet
 * transaction, so by the time it can fail the swap may already be broadcast —
 * a generic "POST /intent failed" line would read as a failed swap. The caller
 * logs the failure with the transaction hash instead, which is the only form
 * of it that tells you what actually happened.
 */
export function useCreateIntentFromQuote() {
  const log = useActivityLog((s) => s.push);
  const network = useActiveDeployment();
  return useMutation({
    mutationFn: async (body: CreateIntentFromQuoteRequest) => {
      const t0 = performance.now();
      const res = await createIntentFromQuote(network.availEscrowBaseUrl, body);
      const dt = Math.round(performance.now() - t0);
      log({
        level: "info",
        channel: "API",
        message: `POST /intent (quote_id · ${body.venue}) · 200 · ${res.id}`,
        details: `${dt}ms`,
      });
      return res;
    },
  });
}

/**
 * Poll a KALQIX intent to its terminal state. "v03" envs use
 * GET /v2/intent/{id}; the legacy env (mainnet) keeps the old
 * GET /intent/{id}. Both shapes normalize to IntentStatusView, so consumers
 * never branch on the API version.
 *
 * Callers must pass null for KYBERSWAP swaps — those have no backend
 * lifecycle; their terminal state is the router tx receipt.
 */
export function useIntentStatus(id: string | null) {
  const network = useActiveDeployment();
  // GET intent version tracks the wire generation, NOT whether the deployment
  // has venues — mainnet serves multi-venue quotes but only the v1 endpoint.
  const v2 = network.apiShape === "v03";
  return useQuery<IntentStatusView | null>({
    queryKey: ["intent", v2 ? "v2" : "v1", network.key, id],
    enabled: !!id,
    queryFn: async () => {
      if (v2) {
        const d = await getIntentV2(network.availEscrowBaseUrl, id!);
        return d ? viewFromV2(d) : null;
      }
      const d = await getIntent(network.availEscrowBaseUrl, id!);
      return d ? viewFromV1(d) : null;
    },
    refetchInterval: (q) =>
      q.state.data?.isTerminal ? false : POLL_MS,
  });
}
