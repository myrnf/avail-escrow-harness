import { useEffect } from "react";
import { useSendTransaction, useWaitForTransactionReceipt } from "wagmi";
import type { Address, Hex } from "viem";
import { useActivityLog } from "../store/activityLog";
import { shortAddress } from "../lib/format";
import { useActiveChain } from "./useSession";

interface DepositArgs {
  to: Address;
  data: Hex;
  value?: bigint;
  /** Explicit gas limit. Aggregator routers need headroom above a bare
   *  eth_estimateGas — see GAS_BUFFER_NUM in SwapForm for why. Omitted, the
   *  wallet estimates and we inherit that risk. */
  gas?: bigint;
}

interface SendCallLabels {
  sent: string;
  confirmed: string;
}

/** Generic raw-calldata sender + receipt watcher. Defaults to the escrow
 *  deposit wording; the KYBERSWAP router path reuses it with its own labels
 *  (pass static strings — labels aren't tracked as effect deps).
 *
 *  Every call is pinned to the SELECTED chain, not the wallet's current one.
 *  wagmi raises ChainMismatchError rather than broadcasting when they differ —
 *  which is the point: calldata built for one chain must never execute on
 *  another. */
export function useDeposit(
  labels: SendCallLabels = {
    sent: "deposit() sent",
    confirmed: "IntentDeposited confirmed",
  }
) {
  const log = useActivityLog((s) => s.push);
  const chain = useActiveChain();
  const send = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({
    hash: send.data,
    chainId: chain.id,
  });

  useEffect(() => {
    if (send.data) {
      log({
        level: "info",
        channel: "TX",
        message: `${labels.sent} · ${shortAddress(send.data)}`,
      });
    }
  }, [send.data, log]);

  useEffect(() => {
    if (receipt.isSuccess && send.data) {
      log({
        level: "ok",
        channel: "EVT",
        message: `${labels.confirmed} · ${shortAddress(send.data)}`,
      });
    }
  }, [receipt.isSuccess, send.data, log]);

  return {
    deposit: (args: DepositArgs) =>
      send.sendTransaction({
        chainId: chain.id,
        to: args.to,
        data: args.data,
        value: args.value ?? 0n,
        ...(args.gas ? { gas: args.gas } : {}),
      }),
    txHash: send.data,
    receipt: receipt.data,
    isPending: send.isPending || receipt.isLoading,
    isSuccess: receipt.isSuccess,
    error: send.error ?? receipt.error,
    reset: send.reset,
  };
}
