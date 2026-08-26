import {
  arbitrum,
  avalanche,
  base,
  baseSepolia,
  berachain,
  bsc,
  etherlink,
  hyperEvm,
  linea,
  mainnet,
  mantle,
  megaeth,
  monad,
  optimism,
  plasma,
  polygon,
  ronin,
  sonic,
  unichain,
} from "viem/chains";
import type { Address, Chain } from "viem";

/** The de-facto native-asset sentinel, registered in Avail's asset registry and
 *  matched on-chain by AvailEscrow's ETH_ADDRESS constant. Represents the chain's
 *  native currency to the API — which is NOT ether on most chains (see
 *  `chain.nativeCurrency` for the real symbol/decimals). */
export const ETH_SENTINEL: Address =
  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export interface ChainConfig {
  id: number;
  chain: Chain;
  /** Display name. Defaults to viem's `chain.name` unless that reads poorly. */
  label: string;
  rpcUrl: string;
  explorerBaseUrl: string;
  /** KyberSwap aggregator path slug, used by the third-party benchmark quote.
   *  Verified against the live aggregator — every routable chain has one. */
  kyberSlug?: string;
  /** KalqiX escrow venue is available here. Base mainnet only: the API serves
   *  KALQIX for chain_id 8453 and nothing else. */
  kalqixEnabled: boolean;
  /** KyberSwap dex ids for QuickSwap's own pools on this chain. Presence of
   *  this field is what marks a chain as a QuickSwap chain — it drives both the
   *  badge and the "QuickSwap pools only" routing toggle. QuickSwap uses Kyber
   *  as its aggregator on Polygon and Base only (Ethereum is Paraswap, and
   *  Kyber exposes no QuickSwap sources there at all). */
  quickswapSources?: string[];
  /** KyberSwap can actually route this chain. False → the chain is listed but
   *  unselectable, with `disabledReason` shown. */
  routable: boolean;
  disabledReason?: string;
}

function cfg(
  chain: Chain,
  extra: Partial<ChainConfig> & Pick<ChainConfig, "kalqixEnabled" | "routable">
): ChainConfig {
  return {
    id: chain.id,
    chain,
    label: chain.name,
    rpcUrl: chain.rpcUrls.default.http[0] ?? "",
    // Trailing slashes vary across viem's chain defs (Mantle has one); strip so
    // the explorer URL helpers don't emit a double slash.
    explorerBaseUrl: (chain.blockExplorers?.default.url ?? "").replace(/\/$/, ""),
    ...extra,
  };
}

/**
 * Every chain the app can select, keyed by chain id.
 *
 * The 18 entries carrying a `kyberSlug` are the API's `chain_id` enum. Base
 * Sepolia is also here because the testnet deployment runs on it, but it is not
 * in the enum and is only ever reachable from that deployment.
 */
export const CHAINS: Record<number, ChainConfig> = {
  [mainnet.id]: cfg(mainnet, {
    label: "Ethereum",
    kyberSlug: "ethereum",
    kalqixEnabled: false,
    routable: true,
    // QuickSwap uses Paraswap on Ethereum, and Kyber lists no QuickSwap dexes
    // here — so deliberately no `quickswapSources`.
  }),
  [optimism.id]: cfg(optimism, {
    label: "Optimism",
    kyberSlug: "optimism",
    kalqixEnabled: false,
    routable: true,
  }),
  [bsc.id]: cfg(bsc, {
    label: "BNB Chain",
    kyberSlug: "bsc",
    kalqixEnabled: false,
    routable: true,
  }),
  [unichain.id]: cfg(unichain, {
    kyberSlug: "unichain",
    kalqixEnabled: false,
    routable: true,
  }),
  [polygon.id]: cfg(polygon, {
    kyberSlug: "polygon",
    kalqixEnabled: false,
    // QuickSwap V2 + V3 (Algebra). V3 here, NOT v4 — v4 is the Base deployment.
    quickswapSources: ["quickswap", "quickswap-v3"],
    routable: true,
  }),
  [monad.id]: cfg(monad, {
    kyberSlug: "monad",
    kalqixEnabled: false,
    routable: true,
  }),
  [sonic.id]: cfg(sonic, {
    kyberSlug: "sonic",
    kalqixEnabled: false,
    routable: true,
  }),
  [hyperEvm.id]: cfg(hyperEvm, {
    label: "HyperEVM",
    kyberSlug: "hyperevm",
    kalqixEnabled: false,
    routable: true,
  }),
  [ronin.id]: cfg(ronin, {
    kyberSlug: "ronin",
    kalqixEnabled: false,
    routable: true,
  }),
  [megaeth.id]: cfg(megaeth, {
    label: "MegaETH",
    kyberSlug: "megaeth",
    kalqixEnabled: false,
    routable: true,
  }),
  // In the API's chain_id enum, but KyberSwap does not route Mantle: its
  // aggregator 404s on the `mantle` slug and its token API 400s for chainId
  // 5000. Listed so the gap is visible rather than silently dropped.
  [mantle.id]: cfg(mantle, {
    kalqixEnabled: false,
    routable: false,
    disabledReason: "no KyberSwap routing",
  }),
  [base.id]: cfg(base, {
    rpcUrl: import.meta.env.VITE_BASE_MAINNET_RPC || base.rpcUrls.default.http[0],
    kyberSlug: "base",
    kalqixEnabled: true,
    // QuickSwap V2 + V4 on Base (v3 is the Polygon deployment).
    quickswapSources: ["quickswap", "quickswap-v4"],
    routable: true,
  }),
  [plasma.id]: cfg(plasma, {
    kyberSlug: "plasma",
    kalqixEnabled: false,
    routable: true,
  }),
  [arbitrum.id]: cfg(arbitrum, {
    label: "Arbitrum",
    kyberSlug: "arbitrum",
    kalqixEnabled: false,
    routable: true,
  }),
  [etherlink.id]: cfg(etherlink, {
    kyberSlug: "etherlink",
    kalqixEnabled: false,
    routable: true,
  }),
  [avalanche.id]: cfg(avalanche, {
    kyberSlug: "avalanche",
    kalqixEnabled: false,
    routable: true,
  }),
  [linea.id]: cfg(linea, {
    label: "Linea",
    kyberSlug: "linea",
    kalqixEnabled: false,
    routable: true,
  }),
  [berachain.id]: cfg(berachain, {
    kyberSlug: "berachain",
    kalqixEnabled: false,
    routable: true,
  }),

  // Not in the chain_id enum — the testnet deployment's own chain. KalqiX-only:
  // Kyber has no Base Sepolia coverage.
  [baseSepolia.id]: cfg(baseSepolia, {
    label: "Base Sepolia",
    rpcUrl: import.meta.env.VITE_BASE_SEPOLIA_RPC || baseSepolia.rpcUrls.default.http[0],
    kalqixEnabled: true,
    routable: true,
  }),
};

/** The API's `chain_id` enum, in selector display order. Excludes Base Sepolia,
 *  which is deployment-pinned rather than selectable. */
export const QUOTE_CHAIN_IDS: number[] = [
  base.id,
  polygon.id,
  mainnet.id,
  arbitrum.id,
  optimism.id,
  bsc.id,
  avalanche.id,
  linea.id,
  unichain.id,
  sonic.id,
  berachain.id,
  hyperEvm.id,
  ronin.id,
  etherlink.id,
  plasma.id,
  monad.id,
  megaeth.id,
  mantle.id,
];

export const DEFAULT_CHAIN_ID = base.id;

export function chainConfig(id: number): ChainConfig {
  const c = CHAINS[id];
  if (!c) throw new Error(`Unknown chain id ${id}`);
  return c;
}

/** True when QuickSwap routes through KyberSwap on this chain, i.e. we can
 *  restrict routing to their own pools. */
export function isQuickswapChain(c: ChainConfig): boolean {
  return !!c.quickswapSources?.length;
}

export function txExplorerUrl(c: ChainConfig, hash: string): string {
  return `${c.explorerBaseUrl}/tx/${hash}`;
}

export function addressExplorerUrl(c: ChainConfig, address: string): string {
  return `${c.explorerBaseUrl}/address/${address}`;
}
