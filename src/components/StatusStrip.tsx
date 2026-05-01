import { useBlockNumber } from "wagmi";
import { ESCROW_CONTRACT_ADDRESS } from "../config/chain";

interface Props {
  intentId: string | null;
}

export function StatusStrip({ intentId }: Props) {
  const block = useBlockNumber({ watch: true });

  return (
    <footer className="status">
      <span className="item">
        <span className="pulse" />
        <span className="label">Live</span>
      </span>
      <span className="item">
        <span className="label">Block</span>
        <b>{block.data ? `#${block.data.toString()}` : "—"}</b>
      </span>
      <span className="item">
        <span className="label">Escrow</span>
        <b>{ESCROW_CONTRACT_ADDRESS}</b>
      </span>
      <span className="ticker">
        {intentId
          ? `— intent ${intentId} active — quote refresh 5s — escrow ${ESCROW_CONTRACT_ADDRESS} —`
          : `— ready — quote refresh 5s — escrow ${ESCROW_CONTRACT_ADDRESS} —`}
      </span>
    </footer>
  );
}
