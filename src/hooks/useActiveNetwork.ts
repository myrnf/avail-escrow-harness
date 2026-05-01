import { useNetworkStore } from "../store/network";
import { NETWORKS, type NetworkConfig } from "../config/networks";

export function useActiveNetwork(): NetworkConfig {
  const key = useNetworkStore((s) => s.active);
  return NETWORKS[key];
}
