import "@rainbow-me/rainbowkit/styles.css";
import { ReactNode, useMemo } from "react";
import { WagmiProvider, http } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, getDefaultConfig, lightTheme } from "@rainbow-me/rainbowkit";
import { WALLETCONNECT_PROJECT_ID } from "../config/chain";
import { NETWORKS } from "../config/networks";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const networks = Object.values(NETWORKS);
const [first, ...rest] = networks;
if (!first) throw new Error("No networks configured");

const transports = Object.fromEntries(
  networks.map((n) => [n.chain.id, http(n.rpcUrl)])
);

const config = getDefaultConfig({
  appName: "Avail × KalqiX Swap Harness",
  projectId: WALLETCONNECT_PROJECT_ID || "avail-kalqix-harness-local",
  chains: [first.chain, ...rest.map((n) => n.chain)] as [typeof first.chain, ...typeof rest[number]["chain"][]],
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
