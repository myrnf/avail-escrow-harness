import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ChainToken } from "../lib/tokens/types";

interface State {
  /** Pasted tokens, keyed by chain id. Persisted so a tester doesn't have to
   *  re-paste an address every reload while working a pair. */
  byChain: Record<number, ChainToken[]>;
  add: (t: ChainToken) => void;
  remove: (chainId: number, address: string) => void;
}

export const useCustomTokenStore = create<State>()(
  persist(
    (set, get) => ({
      byChain: {},
      add: (t) => {
        const list = get().byChain[t.chainId] ?? [];
        if (list.some((x) => x.address.toLowerCase() === t.address.toLowerCase()))
          return;
        set({ byChain: { ...get().byChain, [t.chainId]: [...list, t] } });
      },
      remove: (chainId, address) => {
        const list = get().byChain[chainId] ?? [];
        set({
          byChain: {
            ...get().byChain,
            [chainId]: list.filter(
              (x) => x.address.toLowerCase() !== address.toLowerCase()
            ),
          },
        });
      },
    }),
    { name: "harness.customTokens" }
  )
);
