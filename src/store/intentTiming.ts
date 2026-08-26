import { create } from "zustand";
import type { Venue } from "../config/deployments";

export type StepKey =
  | "submit"          // user clicked "Confirm swap"
  | "permit"          // EIP-2612 permit signature collected (off-chain)
  | "calldata"        // pre-fetched calldata used — no pre-wallet round-trip
  | "createIntent"    // POST /intent returned
  | "deposit"         // deposit tx broadcast (txHash known)
  | "deposited"       // deposit tx confirmed (IntentDeposited)
  | "fill"            // KalqiX order_state went terminal
  | "settled"         // settlement_state went terminal
  | "routerTx"        // KYBERSWAP router tx broadcast (txHash known)
  | "routerConfirmed"; // KYBERSWAP router tx receipt landed — terminal

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
  /** Executing venue chosen at submit. null before the first multi-venue
   *  submit (and on lifecycles recorded by the pre-venue app). */
  venue: Venue | null;
  steps: TimingStep[];
  endedAt: number | null;
  /** KyberSwap benchmark output (tokenOut base units, as a string) snapshotted
   *  at submit time, for the execution-panel comparison. null if unavailable. */
  kyberAmountOut: string | null;
  /** KYBERSWAP only: display string of tokenOut actually received (e.g.
   *  "0.00015747 cbBTC"), summed from the router tx receipt's Transfer logs.
   *  null until confirmed / for KALQIX / for native-ETH output. */
  actualAmountOut: string | null;
}

export const EMPTY_LIFECYCLE: Lifecycle = {
  intentId: null,
  venue: null,
  steps: [],
  endedAt: null,
  kyberAmountOut: null,
  actualAmountOut: null,
};

interface State {
  entries: Record<string, Lifecycle>;
  start: (networkKey: string, venue: Venue) => void;
  setIntentId: (networkKey: string, id: string) => void;
  recordStep: (networkKey: string, step: TimingStep) => void;
  setKyberAmountOut: (networkKey: string, amount: string | null) => void;
  setActualAmountOut: (networkKey: string, amount: string | null) => void;
  end: (networkKey: string, at: number) => void;
  reset: (networkKey: string) => void;
}

export const useIntentTiming = create<State>((set) => ({
  entries: {},

  start: (networkKey, venue) =>
    set((s) => ({
      entries: {
        ...s.entries,
        [networkKey]: {
          intentId: null,
          venue,
          steps: [
            { key: "submit", at: Date.now(), label: "Confirm swap", ok: true },
          ],
          endedAt: null,
          kyberAmountOut: null,
          actualAmountOut: null,
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

  setKyberAmountOut: (networkKey, amount) =>
    set((s) => {
      const cur = s.entries[networkKey] ?? EMPTY_LIFECYCLE;
      return {
        entries: {
          ...s.entries,
          [networkKey]: { ...cur, kyberAmountOut: amount },
        },
      };
    }),

  setActualAmountOut: (networkKey, amount) =>
    set((s) => {
      const cur = s.entries[networkKey] ?? EMPTY_LIFECYCLE;
      return {
        entries: {
          ...s.entries,
          [networkKey]: { ...cur, actualAmountOut: amount },
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
