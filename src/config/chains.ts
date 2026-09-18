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
import { defineChain, type Address, type Chain } from "viem";

/**
 * Chains viem 2.48 does not ship a definition for. Both are recent mainnets and
 * both were confirmed against their own RPC on 2026-09-18 (eth_chainId), so the
 * ids here are measured rather than copied from a chain list.
 */

/** Robinhood Chain — an Arbitrum Orbit L2, mainnet since 2026-07-01. Gas is
 *  ether, so it behaves like every other EVM chain in this app.
 *  eth_chainId → 0x1237 (4663). */
const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
});

/** Arc — Circle's permissioned L1, public mainnet since 2026-09-16. Gas is paid
 *  in USDC, NOT ether. viem ships `arcTestnet` (5042002) only.
 *  eth_chainId → 0x13b2 (5042).
 *
 *  `decimals: 18` is deliberate and is NOT the USDC token's 6. Arc keeps
 *  ordinary wei-scaled accounting for the gas asset and denominates it in USDC,
 *  so the SAME balance reads at two scales (measured 2026-09-18):
 *
 *    eth_getBalance          323773222047000000000000  (÷1e18 → 323,773.222047)
 *    balanceOf(0x3600…0000)            323773222047    (÷1e6  → 323,773.222047)
 *
 *  viem formats eth_getBalance with this field, so 6 here renders a wallet's
 *  balance 1e12 times too large. The 6-decimal view belongs to the ERC-20
 *  predeploy below, which is what actually trades. */
const arc = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://explorer.arc.io" },
  },
});

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
  /** KyberSwap routes this chain but Avail's orchestrator does not carry it in
   *  its `chain_id` enum yet, so POST /v2/quote answers 400 BAD_CHAIN_ID. Set
   *  it to list a chain greyed out while the backend catches up; delete it to
   *  turn the chain on, and nothing else has to change.
   *
   *  Deliberately distinct from `routable`, which is about KyberSwap coverage —
   *  a `backendPending` chain IS routable. No chain carries it today (Robinhood
   *  Chain and Arc both shipped on canary 2026-09-18); it stays as the
   *  mechanism for the next one. */
  backendPending?: string;
  /** This chain's gas token also exists as an ordinary ERC-20 predeploy, and
   *  the predeploy — not the 0xEeee… sentinel — is the tradeable form. Arc is
   *  the case: gas is USDC, and 0x3600…0000 reports symbol "USDC" / 6 decimals
   *  (read from the contract 2026-09-18).
   *
   *  KyberSwap answers "route not found" for the sentinel on such a chain and
   *  canary passes that through as VENUE_ERROR, so the app substitutes this
   *  token for the native one everywhere the native asset would be offered —
   *  see `defaultToken` in lib/tokens. Metadata is carried here rather than
   *  looked up so the substitution works before any token list has loaded. */
  nativeAsErc20?: {
    address: Address;
    symbol: string;
    name: string;
    decimals: number;
  };
  /** Base units of the gas token to hold back when the user presses MAX.
   *  Defaults to DEFAULT_GAS_RESERVE; set it where that default is the wrong
   *  size, which happens when gas is priced in something other than ether. */
  gasReserve?: bigint;
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

  // KYBERSWAP-only, like every chain off Base. Slug `robinhood` reaches chain
  // 4663 and `arc` reaches 5042; canary quotes both with live routes and the
  // right execution_context.chainId (verified 2026-09-18).
  [robinhood.id]: cfg(robinhood, {
    rpcUrl: import.meta.env.VITE_ROBINHOOD_RPC || robinhood.rpcUrls.default.http[0],
    kyberSlug: "robinhood",
    kalqixEnabled: false,
    routable: true,
  }),
  [arc.id]: cfg(arc, {
    rpcUrl: import.meta.env.VITE_ARC_RPC || arc.rpcUrls.default.http[0],
    kyberSlug: "arc",
    kalqixEnabled: false,
    routable: true,
    nativeAsErc20: {
      address: "0x3600000000000000000000000000000000000000",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    },
    // Gas is USDC here, so the 0.0001-of-native default would reserve a
    // hundredth of a cent. A measured Arc swap costs ~0.0066 USDC
    // (330,498 gas × 20.0 gwei), so half a dollar is ample headroom.
    gasReserve: 500_000n, // 0.5 USDC
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

/** Every chain the multi-chain deployments LIST, in selector display order.
 *  Excludes Base Sepolia, which is deployment-pinned rather than selectable.
 *
 *  Membership here is not the same as being tradeable — Mantle is listed and
 *  greyed out — so use `isSelectable` to decide whether a chain can be quoted.
 *  All 20 entries are in the API's `chain_id` enum as of 2026-09-18. */
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
  robinhood.id,
  arc.id,
  // Listed last because it is the one entry the selector greys out — KyberSwap
  // has no routing for it.
  mantle.id,
];

export const DEFAULT_CHAIN_ID = base.id;

export function chainConfig(id: number): ChainConfig {
  const c = CHAINS[id];
  if (!c) throw new Error(`Unknown chain id ${id}`);
  return c;
}

/** MAX headroom on a chain whose gas is ether: 0.0001, which is ample on an L2
 *  (sub-cent) and still negligible on L1. Chains pricing gas in something else
 *  override it with `gasReserve`. */
export const DEFAULT_GAS_RESERVE = 100_000_000_000_000n; // 0.0001 × 1e18

/** True when this token is what the chain charges gas in — the native asset, or
 *  the ERC-20 predeploy standing in for it. Paying a swap with it means MAX has
 *  to hold something back or the transaction can't afford its own gas. */
export function isGasToken(
  c: ChainConfig,
  token: { address: string; isNative?: boolean }
): boolean {
  if (token.isNative) return true;
  const p = c.nativeAsErc20;
  return !!p && p.address.toLowerCase() === token.address.toLowerCase();
}

/** Base units of the gas token to keep back on MAX, in that token's own
 *  decimals — which are the predeploy's, not the native asset's, wherever
 *  `nativeAsErc20` is set. */
export function gasReserveFor(c: ChainConfig): bigint {
  return c.gasReserve ?? DEFAULT_GAS_RESERVE;
}

/** True when the chain can actually be traded from the harness: KyberSwap
 *  routes it AND the orchestrator accepts its chain_id. */
export function isSelectable(c: ChainConfig): boolean {
  return c.routable && !c.backendPending;
}

/** Why a chain is greyed out in the selector, or undefined when it isn't. */
export function unselectableReason(c: ChainConfig): string | undefined {
  return c.routable ? c.backendPending : c.disabledReason;
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
