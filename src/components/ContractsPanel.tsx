import { useState } from "react";
import { Panel } from "./primitives/Panel";
import { useActiveNetwork } from "../hooks/useActiveNetwork";
import { addressExplorerUrl } from "../config/networks";
import { TOKEN_META } from "../config/tokens";

interface Row {
  label: string;
  address: string;
  brand?: string;
}

export function ContractsPanel() {
  const network = useActiveNetwork();
  const [copied, setCopied] = useState<string | null>(null);

  const rows: Row[] = [
    {
      label: "USDC",
      address: network.tokens.USDC,
      brand: TOKEN_META.USDC.brand,
    },
    {
      label: "cbBTC",
      address: network.tokens.cbBTC,
      brand: TOKEN_META.cbBTC.brand,
    },
    {
      label: "Escrow",
      address: network.escrowContract,
    },
  ];

  async function handleCopy(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(address);
      setTimeout(
        () => setCopied((c) => (c === address ? null : c)),
        1500
      );
    } catch {
      /* clipboard unavailable — silent */
    }
  }

  return (
    <Panel title="Contracts">
      {!network.configured ? (
        <div className="contracts__empty">
          {network.shortLabel} not configured yet.
        </div>
      ) : (
        <>
          <div className="contracts__list">
            {rows.map((r) => (
              <div
                key={r.label}
                className="contracts__row"
                role="button"
                tabIndex={0}
                onClick={() => handleCopy(r.address)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void handleCopy(r.address);
                  }
                }}
                title="Click to copy"
              >
                <span className="contracts__label">
                  {r.brand ? (
                    <span
                      className="contracts__dot"
                      style={{ background: r.brand }}
                      aria-hidden
                    />
                  ) : (
                    <span className="contracts__dot contracts__dot--none" aria-hidden />
                  )}
                  {r.label}
                </span>
                <span
                  className={
                    "contracts__address" +
                    (copied === r.address ? " is-copied" : "")
                  }
                >
                  {copied === r.address ? "✓ copied to clipboard" : r.address}
                </span>
                <a
                  href={addressExplorerUrl(network, r.address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="contracts__action"
                  onClick={(e) => e.stopPropagation()}
                  title="Open in explorer"
                >
                  ↗
                </a>
              </div>
            ))}
          </div>
          {network.stakes === "fake" ? (
            <div className="contracts__disclaimer">
              USDC and cbBTC are KalqiX's Base Sepolia test deployments — not
              Circle / Coinbase canonical addresses. Fund your test wallet from
              these.
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}
