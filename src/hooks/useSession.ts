import { useSessionStore } from "../store/session";
import { DEPLOYMENTS, type Deployment } from "../config/deployments";
import { chainConfig, type ChainConfig } from "../config/chains";

/** The Avail backend the app is talking to (API base URLs, escrow, venues). */
export function useActiveDeployment(): Deployment {
  return DEPLOYMENTS[useSessionStore((s) => s.deployment)];
}

/** The EVM chain the user has selected. Always valid for the active
 *  deployment — the session store clamps it on every deployment change. */
export function useActiveChain(): ChainConfig {
  return chainConfig(useSessionStore((s) => s.chainId));
}
