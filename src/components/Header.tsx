import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useBlockNumber, useSwitchChain } from "wagmi";
import { useActiveChain, useActiveDeployment } from "../hooks/useSession";
import { useSessionStore } from "../store/session";
import {
  DEPLOYMENTS,
  isMultiChain,
  type DeploymentKey,
} from "../config/deployments";
import { chainConfig, isQuickswapChain } from "../config/chains";
import { shortAddress } from "../lib/format";

export function Header() {
  const network = useActiveDeployment();
  const chain = useActiveChain();
  const setDeployment = useSessionStore((s) => s.setDeployment);
  const setChainId = useSessionStore((s) => s.setChainId);
  const { isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const block = useBlockNumber({
    watch: true,
    chainId: chain.id,
    query: { refetchInterval: 6_000 },
  });

  const wrongChain =
    isConnected && chainId !== undefined && chainId !== chain.id;

  /** Ask the wallet to follow our selection. Unknown chains (Monad, MegaETH,
   *  Plasma…) surface as a wallet_addEthereumChain prompt; a decline just
   *  leaves the "Wrong network" state, which is recoverable. */
  function requestWalletChain(id: number) {
    if (!isConnected) return;
    try {
      switchChain({ chainId: id });
    } catch {
      /* user can switch manually */
    }
  }

  function pickDeployment(key: DeploymentKey) {
    if (key === network.key) return;
    setDeployment(key);
    // The store clamps the chain into the new deployment's allowed set, so read
    // it back rather than assuming the selection survived.
    requestWalletChain(useSessionStore.getState().chainId);
  }

  function pickChain(id: number) {
    if (id === chain.id) return;
    setChainId(id);
    requestWalletChain(id);
  }

  const selectableChains = network.chainIds.map(chainConfig);
  const showChainSelector = isMultiChain(network);

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
          {(Object.values(DEPLOYMENTS) as { key: DeploymentKey; shortLabel: string; configured: boolean }[]).map(
            (n) => (
              <button
                key={n.key}
                type="button"
                className={
                  "net-toggle__btn" +
                  (network.key === n.key ? " is-active" : "") +
                  (!n.configured ? " is-stub" : "")
                }
                onClick={() => pickDeployment(n.key)}
                title={n.configured ? n.shortLabel : `${n.shortLabel} — not configured`}
              >
                {n.shortLabel}
              </button>
            )
          )}
        </div>

        {/* Chain selector. Hidden on deployments pinned to one chain — notably
            mainnet, whose backend silently ignores chain_id, so offering a
            choice there would produce wrong quotes rather than errors. */}
        {showChainSelector && (
          <label className="chain-select">
            <span className="chain-select__label">CHAIN</span>
            <select
              className="chain-select__input"
              value={chain.id}
              onChange={(e) => pickChain(Number(e.target.value))}
            >
              {selectableChains.map((c) => (
                <option
                  key={c.id}
                  value={c.id}
                  disabled={!c.routable}
                  title={c.disabledReason}
                >
                  {c.label}
                  {isQuickswapChain(c) ? " · QuickSwap" : ""}
                  {c.routable ? "" : ` — ${c.disabledReason}`}
                </option>
              ))}
            </select>
            {isQuickswapChain(chain) && (
              <span
                className="chain-select__badge"
                title="QuickSwap routes through KyberSwap on this chain"
              >
                QS
              </span>
            )}
          </label>
        )}

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
