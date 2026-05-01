import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_NETWORK, type NetworkKey } from "../config/networks";

interface State {
  active: NetworkKey;
  setActive: (k: NetworkKey) => void;
}

export const useNetworkStore = create<State>()(
  persist(
    (set) => ({
      active: DEFAULT_NETWORK,
      setActive: (active) => set({ active }),
    }),
    { name: "harness.network" }
  )
);
