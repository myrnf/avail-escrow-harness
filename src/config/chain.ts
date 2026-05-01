import { baseSepolia } from "wagmi/chains";

export const ACTIVE_CHAIN = baseSepolia;

export const RPC_URL =
  import.meta.env.VITE_BASE_SEPOLIA_RPC || "https://sepolia.base.org";

export const ESCROW_CONTRACT_ADDRESS =
  "0xe87e175EE35Ff028338a0c8D0F28c06427840a07" as const;

export const ETH_SENTINEL =
  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

export const WALLETCONNECT_PROJECT_ID =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "";

export const EXPLORER_BASE_URL = "https://sepolia.basescan.org";

export function txExplorerUrl(hash: string): string {
  return `${EXPLORER_BASE_URL}/tx/${hash}`;
}
