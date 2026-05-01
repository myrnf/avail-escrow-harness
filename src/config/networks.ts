import { base, baseSepolia } from "wagmi/chains";
import type { Address, Chain } from "viem";

export type NetworkKey = "testnet" | "mainnet";

export interface TokenAddresses {
  USDC: Address;
  cbBTC: Address;
}

export interface NetworkConfig {
  key: NetworkKey;
  label: string;
  shortLabel: string;
  chain: Chain;
  rpcUrl: string;
  escrowContract: Address;
  explorerBaseUrl: string;
  kalqixBaseUrl: string;
  availEscrowBaseUrl: string;
  tokens: TokenAddresses;
  /** false → harness shows "not configured" UX and disables swap. */
  configured: boolean;
}

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export const NETWORKS: Record<NetworkKey, NetworkConfig> = {
  testnet: {
    key: "testnet",
    label: "Base Sepolia",
    shortLabel: "TESTNET",
    chain: baseSepolia,
    rpcUrl:
      import.meta.env.VITE_BASE_SEPOLIA_RPC || "https://sepolia.base.org",
    escrowContract: "0xe87e175EE35Ff028338a0c8D0F28c06427840a07",
    explorerBaseUrl: "https://sepolia.basescan.org",
    kalqixBaseUrl: "https://testnet-api.kalqix.com/v1",
    availEscrowBaseUrl: "https://avail-escrow-test.availproject.org",
    tokens: {
      USDC: "0x94d655f6cc102d1e7e3f7a0e66fa604779ca8306",
      cbBTC: "0xe58c5488de4d67dfb186ef955d412ff4473451a8",
    },
    configured: true,
  },

  // ---- Mainnet — placeholders. Fill in once supplied. ----
  // To enable: set every TODO field, set `configured: true`.
  mainnet: {
    key: "mainnet",
    label: "Base",
    shortLabel: "MAINNET",
    chain: base,
    rpcUrl:
      import.meta.env.VITE_BASE_MAINNET_RPC || "https://mainnet.base.org",
    escrowContract: ZERO_ADDRESS, // TODO: supply mainnet escrow contract
    explorerBaseUrl: "https://basescan.org",
    kalqixBaseUrl: "https://api.kalqix.com/v1",
    availEscrowBaseUrl: "", // TODO: supply mainnet Avail Escrow base URL
    tokens: {
      USDC: ZERO_ADDRESS, // TODO: supply mainnet USDC address
      cbBTC: ZERO_ADDRESS, // TODO: supply mainnet cbBTC address
    },
    configured: false,
  },
};

export const DEFAULT_NETWORK: NetworkKey = "testnet";

export const SUPPORTED_CHAINS = Object.values(NETWORKS).map((n) => n.chain);

export function networkForChainId(id: number | undefined): NetworkConfig | null {
  if (id === undefined) return null;
  for (const n of Object.values(NETWORKS)) {
    if (n.chain.id === id) return n;
  }
  return null;
}

export function txExplorerUrl(network: NetworkConfig, hash: string): string {
  return `${network.explorerBaseUrl}/tx/${hash}`;
}
