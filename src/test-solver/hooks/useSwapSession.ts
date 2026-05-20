import { useEffect, useRef, useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import type { Address, Hex } from "viem";
import { erc20Abi } from "../../lib/chain/abis";
import {
  createSwapRequest,
  getSwap,
  notifyDeposit,
  TestSolverError,
} from "../lib/client";
import type { Algo, Side } from "../lib/types";
import { isTerminal } from "../lib/types";
import { useSessionStore } from "../store/session";

const POLL_MS = 1500;

export interface SwapInputs {
  side: Side;
  algo: Algo;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOutMin: bigint;
  amountOutQuote: bigint | null;
}

/**
 * Single hook that orchestrates the test-solver flow from confirm-click to
 * terminal state. State machine intentionally lives here (rather than across
 * many small hooks) so the whole sequence is in one place.
 */
export function useSwapSession() {
  const { address } = useAccount();
  const swap = useSessionStore((s) => s.swap);
  const setSwap = useSessionStore((s) => s.setSwap);
  const reset = useSessionStore((s) => s.reset);

  const erc20Write = useWriteContract();
  const erc20Receipt = useWaitForTransactionReceipt({ hash: erc20Write.data });

  // Local UI state — distinct from server-side swap state.
  const [phase, setPhase] = useState<
    | "idle"
    | "requesting"
    | "awaitingSignature"
    | "awaitingDepositTx"
    | "polling"
    | "done"
  >("idle");
  const [error, setError] = useState<Error | null>(null);

  // Once we have the swap_id and a confirmed deposit tx, poll backend until terminal.
  const pollingRef = useRef<number | null>(null);
  useEffect(() => {
    if (phase !== "polling" || !swap) return;
    const tick = async () => {
      try {
        const updated = await getSwap(swap.id);
        setSwap(updated);
        if (isTerminal(updated.status)) {
          if (pollingRef.current !== null) clearInterval(pollingRef.current);
          setPhase("done");
        }
      } catch (e) {
        // Network blips: keep polling rather than failing the session.
        console.warn("polling error", e);
      }
    };
    void tick();
    const id = window.setInterval(tick, POLL_MS);
    pollingRef.current = id;
    return () => {
      clearInterval(id);
      pollingRef.current = null;
    };
  }, [phase, swap?.id]);

  // When the user's deposit tx confirms onchain, notify the backend.
  // Backend kicks off order placement once it verifies the receipt.
  useEffect(() => {
    if (!swap || !erc20Receipt.isSuccess || !erc20Write.data) return;
    if (swap.deposit_tx_hash) return; // already submitted
    (async () => {
      try {
        const updated = await notifyDeposit(swap.id, erc20Write.data as Hex);
        setSwap(updated);
        setPhase("polling");
      } catch (e) {
        setError(e as Error);
        setPhase("idle");
      }
    })();
  }, [erc20Receipt.isSuccess, erc20Write.data, swap?.id]);

  async function start(inputs: SwapInputs) {
    if (!address) {
      setError(new Error("wallet not connected"));
      return;
    }
    setError(null);
    setPhase("requesting");

    try {
      const req = await createSwapRequest({
        token_in: inputs.tokenIn.toLowerCase() as Address,
        token_out: inputs.tokenOut.toLowerCase() as Address,
        amount_in: inputs.amountIn.toString(),
        amount_out_min: inputs.amountOutMin.toString(),
        amount_out_quote: inputs.amountOutQuote?.toString() ?? null,
        algo: inputs.algo,
        user_eoa: address,
      });

      // Optimistic placeholder so the UI has something to render before the
      // first poll comes back.
      setSwap({
        id: req.swap_id,
        user_eoa: address,
        algo: inputs.algo,
        side: inputs.side,
        token_in: inputs.tokenIn,
        token_out: inputs.tokenOut,
        amount_in: inputs.amountIn.toString(),
        amount_out_min: inputs.amountOutMin.toString(),
        amount_out_quote: inputs.amountOutQuote?.toString() ?? null,
        recipient_eoa: req.recipient_eoa,
        created_at: new Date().toISOString(),
        expires_at: req.expires_at,
        status: "REQUESTED",
        steps: [
          {
            at: new Date().toISOString(),
            status: "REQUESTED",
            note: `algo=${inputs.algo}`,
          },
        ],
        deposit_tx_hash: null,
        payout_tx_hash: null,
        refund_tx_hash: null,
        fill: {
          order_id: null,
          filled_quantity_base: null,
          filled_quantity_quote: null,
          average_price: null,
          taker_fee_paid: null,
          net_payout: null,
        },
        error: null,
      });

      setPhase("awaitingSignature");
      // Trigger the wallet popup for the ERC20 transfer.
      erc20Write.writeContract({
        address: inputs.tokenIn,
        abi: erc20Abi,
        functionName: "transfer",
        args: [req.recipient_eoa, inputs.amountIn],
      });
    } catch (e) {
      const err = e instanceof TestSolverError
        ? new Error(`${e.kind}: ${e.message}`)
        : (e as Error);
      setError(err);
      setPhase("idle");
    }
  }

  // After the deposit tx is signed (but not yet mined), update phase so the UI
  // can reflect "awaiting confirmation".
  useEffect(() => {
    if (erc20Write.data && phase === "awaitingSignature") {
      setPhase("awaitingDepositTx");
    }
  }, [erc20Write.data, phase]);

  function resetSession() {
    reset();
    setPhase("idle");
    setError(null);
    erc20Write.reset();
  }

  return {
    phase,
    swap,
    error: error ?? erc20Write.error ?? erc20Receipt.error ?? null,
    depositTxHash: erc20Write.data as Hex | undefined,
    isInFlight: phase !== "idle" && phase !== "done",
    start,
    reset: resetSession,
  };
}
