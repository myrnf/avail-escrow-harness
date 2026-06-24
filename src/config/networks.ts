import { base, baseSepolia } from "wagmi/chains";
import type { Address, Chain } from "viem";

export type NetworkKey = "testnet" | "canary" | "mainnet";
export type Stakes = "fake" | "real";

export interface TokenAddresses {
  USDC: Address;
  cbBTC: Address;
  /** Native ETH has no ERC-20 contract — this is the Avail escrow sentinel
   *  (ETH_ADDRESS) the `/intent` API and `deposit()` expect for native. */
  ETH: Address;
}

/** Per-network EIP-2612 support flag per token. Testnet's KalqiX-deployed
 *  tokens don't implement permit; canonical Circle USDC + Coinbase cbBTC do.
 *  ETH is native and never permitted. */
export interface PermitSupport {
  USDC: boolean;
  cbBTC: boolean;
  ETH: boolean;
}

/** KalqiX market ticker (URL form, underscore-separated) per non-USDC asset.
 *  USDC is always the quote leg. cbBTC differs by env (testnet trades BTC_USDC,
 *  canary/mainnet trade cbBTC_USDC); ETH is ETH_USDC everywhere. */
export type MarketTickers = Record<"cbBTC" | "ETH", string>;

/** The de-facto native-ETH sentinel address, registered in Avail's asset
 *  registry and matched on-chain by AvailEscrow's ETH_ADDRESS constant. */
export const ETH_SENTINEL: Address =
  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

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
  /** URL-form KalqiX market tickers per non-USDC asset on this env. */
  kalqixMarketTickers: MarketTickers;
  /** KyberSwap aggregator chain slug for the benchmark quote, or undefined if
   *  Kyber has no coverage (e.g. Base Sepolia testnet). Base mainnet = "base". */
  kyberChainSlug?: string;
  /** true → quote via Avail's GET /quote API (the service owns the math);
   *  false/undefined → quote locally via KalqiX + quoteSwap. Mainnet stays
   *  local until Avail ships /quote there (currently 404). */
  useQuoteApi?: boolean;
  availEscrowBaseUrl: string;
  tokens: TokenAddresses;
  permitSupport: PermitSupport;
  /** false → harness shows "not configured" UX and disables swap. */
  configured: boolean;
}

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
    kalqixMarketTickers: { cbBTC: "BTC_USDC", ETH: "ETH_USDC" },
    useQuoteApi: true,
    availEscrowBaseUrl: "https://avail-escrow-test.availproject.org",
    tokens: {
      USDC: "0x94d655f6cc102d1e7e3f7a0e66fa604779ca8306",
      cbBTC: "0xe58c5488de4d67dfb186ef955d412ff4473451a8",
      ETH: ETH_SENTINEL,
    },
    permitSupport: { USDC: false, cbBTC: false, ETH: false },
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
    kalqixMarketTickers: { cbBTC: "cbBTC_USDC", ETH: "ETH_USDC" },
    kyberChainSlug: "base",
    useQuoteApi: true,
    availEscrowBaseUrl: "https://escrow-canary.availproject.org",
    tokens: {
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      ETH: ETH_SENTINEL,
    },
    permitSupport: { USDC: true, cbBTC: true, ETH: false },
    configured: true,
  },

  // ---- Production mainnet — live as of 2026-06-17. Verified end-to-end:
  // /intent returns valid calldata for USDC/cbBTC/ETH (contract matches), and
  // on-chain supportedAssets is true for all three. Same KalqiX env as canary.
  mainnet: {
    key: "mainnet",
    label: "Base Mainnet",
    shortLabel: "MAINNET",
    chain: base,
    stakes: "real",
    rpcUrl:
      import.meta.env.VITE_BASE_MAINNET_RPC || "https://mainnet.base.org",
    escrowContract: "0x74aED8C89b09bd96d87Add00744340289A1Ae90e",
    explorerBaseUrl: "https://basescan.org",
    kalqixBaseUrl: "https://api.kalqix.com/v1",
    kalqixMarketTickers: { cbBTC: "cbBTC_USDC", ETH: "ETH_USDC" },
    kyberChainSlug: "base",
    // Local quoting until Avail ships GET /quote on mainnet (currently 404).
    useQuoteApi: false,
    availEscrowBaseUrl: "https://atomic.api.mainnet.availproject.org",
    tokens: {
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      ETH: ETH_SENTINEL,
    },
    permitSupport: { USDC: true, cbBTC: true, ETH: false },
    configured: true,
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
