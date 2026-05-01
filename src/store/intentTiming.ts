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

export interface Lifecycle {
  intentId: string | null;
  steps: TimingStep[];
  endedAt: number | null;
}

export const EMPTY_LIFECYCLE: Lifecycle = {
  intentId: null,
  steps: [],
  endedAt: null,
};

interface State {
  entries: Record<string, Lifecycle>;
  start: (networkKey: string) => void;
  setIntentId: (networkKey: string, id: string) => void;
  recordStep: (networkKey: string, step: TimingStep) => void;
  end: (networkKey: string, at: number) => void;
  reset: (networkKey: string) => void;
}

export const useIntentTiming = create<State>((set) => ({
  entries: {},

  start: (networkKey) =>
    set((s) => ({
      entries: {
        ...s.entries,
        [networkKey]: {
          intentId: null,
          steps: [
            { key: "submit", at: Date.now(), label: "Confirm swap", ok: true },
          ],
          endedAt: null,
        },
      },
    })),

  setIntentId: (networkKey, id) =>
    set((s) => {
      const cur = s.entries[networkKey] ?? EMPTY_LIFECYCLE;
      return {
        entries: { ...s.entries, [networkKey]: { ...cur, intentId: id } },
      };
    }),

  recordStep: (networkKey, step) =>
    set((s) => {
      const cur = s.entries[networkKey] ?? EMPTY_LIFECYCLE;
      // dedupe — first occurrence of a key wins
      if (cur.steps.some((x) => x.key === step.key)) return s;
      return {
        entries: {
          ...s.entries,
          [networkKey]: { ...cur, steps: [...cur.steps, step] },
        },
      };
    }),

  // Idempotent — once endedAt is set, additional end() calls are ignored so
  // returning to a settled lifecycle (e.g. after a network round-trip) doesn't
  // reset the historical total time.
  end: (networkKey, at) =>
    set((s) => {
      const cur = s.entries[networkKey] ?? EMPTY_LIFECYCLE;
      if (cur.endedAt !== null) return s;
      return {
        entries: { ...s.entries, [networkKey]: { ...cur, endedAt: at } },
      };
    }),

  reset: (networkKey) =>
    set((s) => ({
      entries: { ...s.entries, [networkKey]: EMPTY_LIFECYCLE },
    })),
}));

export function isInFlight(lc: Lifecycle): boolean {
  return lc.steps.length > 0 && lc.endedAt === null;
}
