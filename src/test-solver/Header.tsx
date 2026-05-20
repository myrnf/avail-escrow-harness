import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useBlockNumber } from "wagmi";
import { NETWORKS } from "../config/networks";
import { shortAddress } from "../lib/format";

const NETWORK = NETWORKS.canary; // test-solver is implicitly Base mainnet

export function Header() {
  const { isConnected, chainId } = useAccount();
  const block = useBlockNumber({
    watch: true,
    chainId: NETWORK.chain.id,
    query: { refetchInterval: 6_000 },
  });
  const wrongChain =
    isConnected && chainId !== undefined && chainId !== NETWORK.chain.id;

  return (
    <header className="header">
      <div className="brand">
        <span>TEST</span>
        <span className="brand__sep">·</span>
        <span>SOLVER</span>
        <span className="brand__sep">/</span>
        <a href="/" className="brand__label brand__link">
          BACK TO HARNESS
        </a>
      </div>

      <div className="header__meta">
        <span className="crumb">
          NET <b>{NETWORK.label.toUpperCase()}</b>
        </span>
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
                <button className="connect-btn" type="button" aria-hidden disabled style={{ opacity: 0.5 }}>
                  <span className="connect-btn__dot" data-state="idle" />
                  Loading…
                </button>
              );
            }
            if (!connected) {
              return (
                <button className="connect-btn" type="button" onClick={openConnectModal}>
                  <span className="connect-btn__dot" data-state="idle" />
                  Connect wallet
                </button>
              );
            }
            if (chain.unsupported || wrongChain) {
              return (
                <button className="connect-btn is-warn" type="button" onClick={openChainModal}>
                  <span className="connect-btn__dot" data-state="warn" />
                  Wrong network
                </button>
              );
            }
            return (
              <button className="connect-btn is-connected" type="button" onClick={openAccountModal}>
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
