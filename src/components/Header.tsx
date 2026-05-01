import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useBlockNumber } from "wagmi";
import { ACTIVE_CHAIN } from "../config/chain";
import { shortAddress } from "../lib/format";

export function Header() {
  const block = useBlockNumber({ watch: true, query: { refetchInterval: 6_000 } });

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
        <span className="crumb">
          CHAIN <b>{ACTIVE_CHAIN.name.toUpperCase()}</b>
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
            const ready =
              mounted && authenticationStatus !== "loading";
            const connected =
              ready &&
              account &&
              chain &&
              (!authenticationStatus || authenticationStatus === "authenticated");

            // While RainbowKit is mounting, render a non-clickable shell so
            // the layout doesn't jump and the user always sees a button.
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

            if (chain.unsupported) {
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
