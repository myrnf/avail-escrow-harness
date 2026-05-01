import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useBlockNumber, useSwitchChain } from "wagmi";
import { useActiveNetwork } from "../hooks/useActiveNetwork";
import { useNetworkStore } from "../store/network";
import { NETWORKS, type NetworkKey } from "../config/networks";
import { shortAddress } from "../lib/format";

export function Header() {
  const network = useActiveNetwork();
  const setActive = useNetworkStore((s) => s.setActive);
  const { isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const block = useBlockNumber({
    watch: true,
    chainId: network.chain.id,
    query: { refetchInterval: 6_000 },
  });

  const wrongChain =
    isConnected && chainId !== undefined && chainId !== network.chain.id;

  function pickNetwork(key: NetworkKey) {
    if (key === network.key) return;
    setActive(key);
    if (isConnected) {
      try {
        switchChain({ chainId: NETWORKS[key].chain.id });
      } catch {
        /* user can switch manually */
      }
    }
  }

  return (
    <header className="header">
      <div className="brand">
        <span>AVAIL</span>
        <span className="brand__sep">×</span>
        <span>KALQIX</span>
        <span className="brand__sep">/</span>
        <span className="brand__label">SWAP HARNESS</span>
      </div>

      <div className="header__meta">
        {/* Network toggle */}
        <div className="net-toggle" role="group" aria-label="Network">
          {(Object.values(NETWORKS) as { key: NetworkKey; shortLabel: string; configured: boolean }[]).map(
            (n) => (
              <button
                key={n.key}
                type="button"
                className={
                  "net-toggle__btn" +
                  (network.key === n.key ? " is-active" : "") +
                  (!n.configured ? " is-stub" : "")
                }
                onClick={() => pickNetwork(n.key)}
                title={n.configured ? n.shortLabel : `${n.shortLabel} — not configured`}
              >
                {n.shortLabel}
              </button>
            )
          )}
        </div>

        <span className="crumb">
          BLOCK <b>{block.data ? `#${block.data.toString()}` : "—"}</b>
        </span>

        <ConnectButton.Custom>
          {({
            account,
            chain,
            openAccountModal,
            openChainModal,
            openConnectModal,
            mounted,
            authenticationStatus,
          }) => {
            const ready = mounted && authenticationStatus !== "loading";
            const connected =
              ready &&
              account &&
              chain &&
              (!authenticationStatus || authenticationStatus === "authenticated");

            if (!ready) {
              return (
                <button
                  className="connect-btn"
                  type="button"
                  aria-hidden
                  disabled
                  style={{ opacity: 0.5 }}
                >
                  <span className="connect-btn__dot" data-state="idle" />
                  Loading…
                </button>
              );
            }
            if (!connected) {
              return (
                <button
                  className="connect-btn"
                  type="button"
                  onClick={openConnectModal}
                >
                  <span className="connect-btn__dot" data-state="idle" />
                  Connect wallet
                </button>
              );
            }
            if (chain.unsupported || wrongChain) {
              return (
                <button
                  className="connect-btn is-warn"
                  type="button"
                  onClick={openChainModal}
                >
                  <span className="connect-btn__dot" data-state="warn" />
                  Wrong network
                </button>
              );
            }
            return (
              <button
                className="connect-btn is-connected"
                type="button"
                onClick={openAccountModal}
              >
                <span className="connect-btn__dot" data-state="ok" />
                {shortAddress(account.address)}
              </button>
            );
          }}
        </ConnectButton.Custom>
      </div>
    </header>
  );
}
