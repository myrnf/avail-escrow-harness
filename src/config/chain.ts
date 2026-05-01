// Network-specific values (chain, RPC, escrow contract, explorer URL) live in
// `networks.ts`. This file holds the cross-network constants only.

export const ETH_SENTINEL =
  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

export const WALLETCONNECT_PROJECT_ID =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "";
