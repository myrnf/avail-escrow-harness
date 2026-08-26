import "@rainbow-me/rainbowkit/styles.css";
import { ReactNode, useMemo } from "react";
import { WagmiProvider, http } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, getDefaultConfig, lightTheme } from "@rainbow-me/rainbowkit";
import { WALLETCONNECT_PROJECT_ID } from "../config/chain";
import { CHAINS } from "../config/chains";
import type { Chain } from "viem";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Every chain in the registry, keyed by id — so the entry per chain is unique
// even though several deployments share Base. Wallets that don't know a chain
// (Monad, MegaETH, Plasma, Etherlink…) get prompted with wallet_addEthereumChain
// on switch, using the params from viem's chain definitions.
const chainList = Object.values(CHAINS);
const [firstChain, ...restChains] = chainList;
if (!firstChain) throw new Error("No chains configured");

const transports = Object.fromEntries(
  chainList.map((c) => [c.id, http(c.rpcUrl)])
);

const config = getDefaultConfig({
  appName: "Avail × KalqiX Swap Harness",
  projectId: WALLETCONNECT_PROJECT_ID || "avail-kalqix-harness-local",
  chains: [firstChain.chain, ...restChains.map((c) => c.chain)] as [
    Chain,
    ...Chain[],
  ],
  transports,
  ssr: false,
});

export function Web3Provider({ children }: { children: ReactNode }) {
  const theme = useMemo(
    () =>
      lightTheme({
        accentColor: "#1e40af",
        accentColorForeground: "#f7f4ed",
        borderRadius: "small",
        fontStack: "system",
      }),
    []
  );

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={theme} modalSize="compact">
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
