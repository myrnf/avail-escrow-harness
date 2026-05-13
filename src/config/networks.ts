import { base, baseSepolia } from "wagmi/chains";
import type { Address, Chain } from "viem";

export type NetworkKey = "testnet" | "canary" | "mainnet";
export type Stakes = "fake" | "real";

export interface TokenAddresses {
  USDC: Address;
  cbBTC: Address;
}

/** Per-network EIP-2612 support flag per token. Testnet's KalqiX-deployed
 *  tokens don't implement permit; canonical Circle USDC + Coinbase cbBTC do. */
export interface PermitSupport {
  USDC: boolean;
  cbBTC: boolean;
}

export interface NetworkConfig {
  key: NetworkKey;
  label: string;
  shortLabel: string;
  chain: Chain;
  /** "fake" → testnet (no real value); "real" → real funds at risk. */
  stakes: Stakes;
  rpcUrl: string;
  escrowContract: Address;
  explorerBaseUrl: string;
  kalqixBaseUrl: string;
  /** URL-form ticker for the cbBTC ↔ USDC market on this KalqiX env. */
  kalqixMarketTicker: string;
  availEscrowBaseUrl: string;
  tokens: TokenAddresses;
  permitSupport: PermitSupport;
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
    stakes: "fake",
    rpcUrl:
      import.meta.env.VITE_BASE_SEPOLIA_RPC || "https://sepolia.base.org",
    escrowContract: "0xDF06678Ca95fDBe30a719675779209B76370a1ee",
    explorerBaseUrl: "https://sepolia.basescan.org",
    kalqixBaseUrl: "https://testnet-api.kalqix.com/v1",
    kalqixMarketTicker: "BTC_USDC",
    availEscrowBaseUrl: "https://avail-escrow-test.availproject.org",
    tokens: {
      USDC: "0x94d655f6cc102d1e7e3f7a0e66fa604779ca8306",
      cbBTC: "0xe58c5488de4d67dfb186ef955d412ff4473451a8",
    },
    permitSupport: { USDC: false, cbBTC: false },
    configured: true,
  },

  canary: {
    key: "canary",
    label: "Base Canary",
    shortLabel: "CANARY",
    chain: base,
    stakes: "real",
    rpcUrl:
      import.meta.env.VITE_BASE_MAINNET_RPC || "https://mainnet.base.org",
    escrowContract: "0xDF06678Ca95fDBe30a719675779209B76370a1ee",
    explorerBaseUrl: "https://basescan.org",
    kalqixBaseUrl: "https://api.kalqix.com/v1",
    kalqixMarketTicker: "cbBTC_USDC",
    availEscrowBaseUrl: "https://escrow-canary.availproject.org",
    tokens: {
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    },
    permitSupport: { USDC: true, cbBTC: true },
    configured: true,
  },

  // ---- Production mainnet — stub. Fill in once Avail ships prod escrow. ----
  // To enable: set escrowContract + availEscrowBaseUrl, flip configured: true.
  // Token addresses are already canonical Circle USDC / Coinbase cbBTC.
  mainnet: {
    key: "mainnet",
    label: "Base Mainnet",
    shortLabel: "MAINNET",
    chain: base,
    stakes: "real",
    rpcUrl:
      import.meta.env.VITE_BASE_MAINNET_RPC || "https://mainnet.base.org",
    escrowContract: ZERO_ADDRESS, // TODO: production escrow contract
    explorerBaseUrl: "https://basescan.org",
    kalqixBaseUrl: "https://api.kalqix.com/v1",
    kalqixMarketTicker: "cbBTC_USDC",
    availEscrowBaseUrl: "", // TODO: production Avail Escrow base URL
    tokens: {
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    },
    permitSupport: { USDC: true, cbBTC: true },
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

export function addressExplorerUrl(
  network: NetworkConfig,
  address: string
): string {
  return `${network.explorerBaseUrl}/address/${address}`;
}
