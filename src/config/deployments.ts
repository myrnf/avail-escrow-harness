import type { Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { ETH_SENTINEL, QUOTE_CHAIN_IDS } from "./chains";

/** Execution venues the Avail orchestrator can quote and route through. */
export type Venue = "KALQIX" | "KYBERSWAP";

export type DeploymentKey = "testnet" | "canary" | "mainnet";
export type Stakes = "fake" | "real";

/**
 * Which generation of the Escrow API a deployment serves. These are wire-
 * incompatible in both directions, so every request and response must be built
 * and read against the right one.
 *
 * "v03"    — testnet, canary. POST /v2/quote with `venues` / `kalqix` /
 *            `kyberswap`, responses keyed `quote_id` / `venue` / `details`,
 *            `create_calldata` supported, GET /v2/intent/{id}. Rejects unknown
 *            request fields outright (422).
 * "legacy" — mainnet. Pre-0.2.0: `whitelisted_venues` / `venue_options`,
 *            responses keyed `id` / `venue_name` / `venue_detail`, no
 *            calldata-on-quote, GET /intent/{id}. IGNORES unknown fields
 *            rather than rejecting, so a wrong-shape request here fails
 *            silently as a plausible-looking quote rather than an error.
 */
export type ApiShape = "v03" | "legacy";

/** KalqiX-tradeable tokens on a deployment's Base chain. KalqiX is Base-only,
 *  so these are deployment-scoped rather than per-chain. The Kyber path does
 *  not use them — it resolves tokens per chain (see src/lib/tokens). */
export interface KalqixTokens {
  USDC: Address;
  cbBTC: Address;
  /** Native has no ERC-20 contract — this is the escrow sentinel. */
  ETH: Address;
}

/** EIP-2612 support per KalqiX token. Testnet's KalqiX-deployed tokens don't
 *  implement permit; canonical Circle USDC + Coinbase cbBTC do. Native is
 *  never permitted. */
export interface PermitSupport {
  USDC: boolean;
  cbBTC: boolean;
  ETH: boolean;
}

/** URL-form KalqiX market tickers per non-USDC asset. USDC is always the quote
 *  leg. cbBTC differs by env (testnet trades BTC_USDC); ETH is ETH_USDC. */
export type MarketTickers = Record<"cbBTC" | "ETH", string>;

export interface Deployment {
  key: DeploymentKey;
  label: string;
  shortLabel: string;
  /** "fake" → testnet (no real value); "real" → real funds at risk. */
  stakes: Stakes;
  availEscrowBaseUrl: string;
  kalqixBaseUrl: string;
  escrowContract: Address;
  /** Chain ids selectable on this deployment. More than one → the chain
   *  selector is shown. A single entry means this backend does not honour
   *  `chain_id` and must stay pinned to that chain. */
  chainIds: number[];
  /** Venues this deployment quotes and executes. Present → the app uses
   *  POST /v2/quote and venue-aware POST /intent. ABSENT → local KalqiX
   *  quoting only.
   *
   *  This used to also imply the wire shape and the GET /intent version. It no
   *  longer does — mainnet serves multi-venue quotes on the OLD shape, so those
   *  are `apiShape` now. Keep the three independent. */
  venues?: Venue[];
  /** Wire generation this deployment speaks. See ApiShape. */
  apiShape: ApiShape;
  /** `chain_id` to send to /v2/quote when it differs from the chain we actually
   *  broadcast on. Only testnet needs this — see the note on that entry.
   *  Absent → quote and execute on the same chain, which is the sane case. */
  quoteChainId?: number;
  kalqixTokens: KalqixTokens;
  permitSupport: PermitSupport;
  kalqixMarketTickers: MarketTickers;
  /** false → harness shows "not configured" UX and disables swap. */
  configured: boolean;
}

export const DEPLOYMENTS: Record<DeploymentKey, Deployment> = {
  testnet: {
    key: "testnet",
    label: "Base Sepolia",
    shortLabel: "TESTNET",
    stakes: "fake",
    availEscrowBaseUrl: "https://avail-escrow-test.availproject.org",
    kalqixBaseUrl: "https://testnet-api.kalqix.com/v1",
    escrowContract: "0xDF06678Ca95fDBe30a719675779209B76370a1ee",
    // Base Sepolia only. KALQIX-only on purpose: Kyber has no coverage here.
    chainIds: [baseSepolia.id],
    venues: ["KALQIX"],
    apiShape: "v03",
    // This backend REJECTS chain_id 84532 outright (top-level BAD_CHAIN_ID,
    // "Unsupported chain_id: 84532") but resolves its Base *Sepolia* KALQIX
    // assets under 8453, returning deposit calldata for the Sepolia escrow
    // below. So here `chain_id` selects the asset registry, not the broadcast
    // chain. Verified 2026-08-20. Quotes go out as 8453; useDeposit still pins
    // the transaction to chainIds[0] (84532) via wagmi, and that guard must not
    // be relaxed to match.
    quoteChainId: base.id,
    kalqixTokens: {
      USDC: "0x94d655f6cc102d1e7e3f7a0e66fa604779ca8306",
      cbBTC: "0xe58c5488de4d67dfb186ef955d412ff4473451a8",
      ETH: ETH_SENTINEL,
    },
    permitSupport: { USDC: false, cbBTC: false, ETH: false },
    kalqixMarketTickers: { cbBTC: "BTC_USDC", ETH: "ETH_USDC" },
    configured: true,
  },

  // The only deployment running the v0.2.0 multi-chain orchestrator. Verified
  // 2026-08-10: honours chain_id (400 BAD_CHAIN_ID on off-enum values) and
  // returns live routable quotes on 17 of the 18 enum chains.
  canary: {
    key: "canary",
    label: "Canary",
    shortLabel: "CANARY",
    stakes: "real",
    availEscrowBaseUrl: "https://escrow-canary.availproject.org",
    kalqixBaseUrl: "https://api.kalqix.com/v1",
    escrowContract: "0xDF06678Ca95fDBe30a719675779209B76370a1ee",
    chainIds: QUOTE_CHAIN_IDS,
    venues: ["KALQIX", "KYBERSWAP"],
    apiShape: "v03",
    kalqixTokens: {
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      ETH: ETH_SENTINEL,
    },
    permitSupport: { USDC: true, cbBTC: true, ETH: false },
    kalqixMarketTickers: { cbBTC: "cbBTC_USDC", ETH: "ETH_USDC" },
    configured: true,
  },

  // Production mainnet. Pinned to Base: this deployment runs a pre-v0.2.0 build
  // that SILENTLY IGNORES chain_id — verified 2026-08-10, a request for
  // chain_id 1868 returned 200 (not BAD_CHAIN_ID) and non-Base token addresses
  // were quoted as if they were on Base. Selecting another chain here would
  // produce a plausible but wrong quote, so the selector stays locked.
  mainnet: {
    key: "mainnet",
    label: "Mainnet",
    shortLabel: "MAINNET",
    stakes: "real",
    availEscrowBaseUrl: "https://atomic.api.mainnet.availproject.org",
    kalqixBaseUrl: "https://api.kalqix.com/v1",
    escrowContract: "0x74aED8C89b09bd96d87Add00744340289A1Ae90e",
    chainIds: [base.id],
    // This backend DOES serve multi-venue quotes (KALQIX + KYBERSWAP) and
    // honours QuickSwap source restriction — verified 2026-08-31, USDC→cbBTC
    // returned both venues, and a restricted USDC→WETH routed quickswap-v4
    // against aerodrome-cl unrestricted. It just speaks the old wire shape,
    // which is why apiShape is "legacy" rather than venues being absent.
    // No calldata-on-quote here: `create_calldata` is silently ignored, so
    // mainnet always fetches calldata at confirm.
    venues: ["KALQIX", "KYBERSWAP"],
    apiShape: "legacy",
    kalqixTokens: {
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      ETH: ETH_SENTINEL,
    },
    permitSupport: { USDC: true, cbBTC: true, ETH: false },
    kalqixMarketTickers: { cbBTC: "cbBTC_USDC", ETH: "ETH_USDC" },
    configured: true,
  },
};

export const DEFAULT_DEPLOYMENT: DeploymentKey = "testnet";

/** True when this deployment honours `chain_id` and can offer a chain selector. */
export function isMultiChain(d: Deployment): boolean {
  return d.chainIds.length > 1;
}

export function venueEnabled(d: Deployment, venue: Venue): boolean {
  return !!d.venues?.includes(venue);
}
