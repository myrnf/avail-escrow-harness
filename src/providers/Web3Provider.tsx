import "@rainbow-me/rainbowkit/styles.css";
import { ReactNode, useMemo } from "react";
import { WagmiProvider, http } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, getDefaultConfig, lightTheme } from "@rainbow-me/rainbowkit";
import {
  ACTIVE_CHAIN,
  RPC_URL,
  WALLETCONNECT_PROJECT_ID,
} from "../config/chain";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // KalqiX quotes refetch via their own staleTime; default is fine elsewhere.
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const config = getDefaultConfig({
  appName: "Avail × KalqiX Swap Harness",
  // RainbowKit requires a non-empty string. WalletConnect features are gated
  // behind a real projectId; without one, injected wallets still work fine.
  projectId: WALLETCONNECT_PROJECT_ID || "avail-kalqix-harness-local",
  chains: [ACTIVE_CHAIN],
  transports: {
    [ACTIVE_CHAIN.id]: http(RPC_URL),
  },
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
