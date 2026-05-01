import { useBlockNumber } from "wagmi";
import { useActiveNetwork } from "../hooks/useActiveNetwork";

interface Props {
  intentId: string | null;
}

export function StatusStrip({ intentId }: Props) {
  const network = useActiveNetwork();
  const block = useBlockNumber({ watch: true, chainId: network.chain.id });

  return (
    <footer className="status">
      <span className="item">
        <span className="pulse" />
        <span className="label">Live</span>
      </span>
      <span className="item">
        <span className="label">Net</span>
        <b>{network.label}</b>
      </span>
      <span className="item">
        <span className="label">Block</span>
        <b>{block.data ? `#${block.data.toString()}` : "—"}</b>
      </span>
      <span className="item">
        <span className="label">Escrow</span>
        <b>{network.escrowContract}</b>
      </span>
      <span className="ticker">
        {intentId
          ? `— intent ${intentId} active — quote refresh 5s — escrow ${network.escrowContract} —`
          : `— ${network.shortLabel.toLowerCase()} ready — quote refresh 5s — escrow ${network.escrowContract} —`}
      </span>
    </footer>
  );
}
