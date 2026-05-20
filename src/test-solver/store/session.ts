import { create } from "zustand";
import type { Swap } from "../lib/types";

interface SessionState {
  /** The currently-active swap session, if any. */
  swap: Swap | null;
  setSwap: (s: Swap | null) => void;
  reset: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  swap: null,
  setSwap: (swap) => set({ swap }),
  reset: () => set({ swap: null }),
}));
