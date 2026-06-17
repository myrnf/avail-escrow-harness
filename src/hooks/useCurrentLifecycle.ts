import { useMemo } from "react";
import {
  useIntentTiming,
  EMPTY_LIFECYCLE,
  type Lifecycle,
  type TimingStep,
} from "../store/intentTiming";
import { useActiveNetwork } from "./useActiveNetwork";

export interface CurrentLifecycle extends Lifecycle {
  start: () => void;
  setIntentId: (id: string) => void;
  recordStep: (step: TimingStep) => void;
  setKyberAmountOut: (amount: string | null) => void;
  end: (at: number) => void;
  reset: () => void;
}

/**
 * Returns the lifecycle slice for the currently-active network plus a set of
 * actions bound to that network key. Switching networks gives you a different
 * slice; per-network history is preserved across switches.
 */
export function useCurrentLifecycle(): CurrentLifecycle {
  const networkKey = useActiveNetwork().key;
  const lifecycle = useIntentTiming(
    (s) => s.entries[networkKey] ?? EMPTY_LIFECYCLE
  );

  const start = useIntentTiming((s) => s.start);
  const setIntentId = useIntentTiming((s) => s.setIntentId);
  const recordStep = useIntentTiming((s) => s.recordStep);
  const setKyberAmountOut = useIntentTiming((s) => s.setKyberAmountOut);
  const end = useIntentTiming((s) => s.end);
  const reset = useIntentTiming((s) => s.reset);

  return useMemo(
    () => ({
      ...lifecycle,
      start: () => start(networkKey),
      setIntentId: (id: string) => setIntentId(networkKey, id),
      recordStep: (step: TimingStep) => recordStep(networkKey, step),
      setKyberAmountOut: (amount: string | null) =>
        setKyberAmountOut(networkKey, amount),
      end: (at: number) => end(networkKey, at),
      reset: () => reset(networkKey),
    }),
    [lifecycle, networkKey, start, setIntentId, recordStep, setKyberAmountOut, end, reset]
  );
}
