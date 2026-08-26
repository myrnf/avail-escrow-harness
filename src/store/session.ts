import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_DEPLOYMENT,
  DEPLOYMENTS,
  type DeploymentKey,
} from "../config/deployments";
import { DEFAULT_CHAIN_ID } from "../config/chains";

/** Pick a valid chain for a deployment, preferring the caller's current choice,
 *  then Base, then whatever the deployment does offer. Switching deployments
 *  must never leave a chain selected that its backend can't serve — mainnet
 *  silently ignores chain_id, so a stale selection there is a wrong quote
 *  rather than an error. */
function clampChain(key: DeploymentKey, preferred: number): number {
  const allowed = DEPLOYMENTS[key].chainIds;
  if (allowed.includes(preferred)) return preferred;
  if (allowed.includes(DEFAULT_CHAIN_ID)) return DEFAULT_CHAIN_ID;
  return allowed[0] ?? DEFAULT_CHAIN_ID;
}

interface State {
  deployment: DeploymentKey;
  chainId: number;
  setDeployment: (k: DeploymentKey) => void;
  setChainId: (id: number) => void;
}

export const useSessionStore = create<State>()(
  persist(
    (set, get) => ({
      deployment: DEFAULT_DEPLOYMENT,
      chainId: clampChain(DEFAULT_DEPLOYMENT, DEFAULT_CHAIN_ID),
      setDeployment: (deployment) =>
        set({ deployment, chainId: clampChain(deployment, get().chainId) }),
      setChainId: (chainId) => set({ chainId }),
    }),
    {
      // Deliberately not "harness.network": the old shape persisted only a
      // network key, and rehydrating it into this store would leave chainId
      // unset. A fresh key makes existing clients fall back to defaults.
      name: "harness.session",
      // Re-clamp on rehydrate — the persisted chain may no longer be offered
      // if a deployment's chain list changed between releases.
      onRehydrateStorage: () => (state) => {
        if (state) state.chainId = clampChain(state.deployment, state.chainId);
      },
    }
  )
);
