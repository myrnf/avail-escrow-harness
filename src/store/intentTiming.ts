import { create } from "zustand";

export type StepKey =
  | "submit"        // user clicked "Confirm swap"
  | "createIntent"  // POST /intent returned
  | "deposit"       // deposit tx broadcast (txHash known)
  | "deposited"     // deposit tx confirmed (IntentDeposited)
  | "fill"          // KalqiX order_state went terminal
  | "settled";      // settlement_state went terminal

export interface TimingStep {
  key: StepKey;
  at: number;
  label: string;
  ok: boolean;
  detail?: string;
  tx?: string;
}

interface State {
  intentId: string | null;
  steps: TimingStep[];
  endedAt: number | null;
  start: () => void;
  setIntentId: (id: string) => void;
  recordStep: (step: TimingStep) => void;
  end: (at: number) => void;
  reset: () => void;
}

export const useIntentTiming = create<State>((set) => ({
  intentId: null,
  steps: [],
  endedAt: null,
  start: () =>
    set({
      intentId: null,
      endedAt: null,
      steps: [
        {
          key: "submit",
          at: Date.now(),
          label: "Confirm swap",
          ok: true,
        },
      ],
    }),
  setIntentId: (id) => set({ intentId: id }),
  recordStep: (step) =>
    set((s) => {
      // dedupe: a step's first occurrence wins
      if (s.steps.some((x) => x.key === step.key)) return s;
      return { ...s, steps: [...s.steps, step] };
    }),
  end: (at) => set({ endedAt: at }),
  reset: () => set({ intentId: null, steps: [], endedAt: null }),
}));

export function isInFlight(steps: TimingStep[], endedAt: number | null): boolean {
  return steps.length > 0 && endedAt === null;
}
