import { useQuery, useMutation } from "@tanstack/react-query";
import {
  createIntent,
  getIntent,
  isOrderTerminal,
  isSettlementTerminal,
  type CreateIntentRequest,
} from "../lib/intent";
import { useActivityLog } from "../store/activityLog";
import { useActiveNetwork } from "./useActiveNetwork";

const POLL_MS = 2500;

export function useCreateIntent() {
  const log = useActivityLog((s) => s.push);
  const network = useActiveNetwork();
  return useMutation({
    mutationFn: async (body: CreateIntentRequest) => {
      const t0 = performance.now();
      const success = await createIntent(network.availEscrowBaseUrl, body);
      const dt = Math.round(performance.now() - t0);
      log({
        level: "info",
        channel: "API",
        message: `POST /intent · 200 · solver ${success.solver_address.slice(0, 6)}…${success.solver_address.slice(-4)}`,
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

export function useIntentStatus(id: string | null) {
  const network = useActiveNetwork();
  return useQuery({
    queryKey: ["intent", network.key, id],
    enabled: !!id,
    queryFn: () => getIntent(network.availEscrowBaseUrl, id!),
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return POLL_MS;
      if (isOrderTerminal(d.order_state) && isSettlementTerminal(d.settlement_state)) {
        return false;
      }
      return POLL_MS;
    },
  });
}
