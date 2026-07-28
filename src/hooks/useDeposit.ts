import { useEffect } from "react";
import { useSendTransaction, useWaitForTransactionReceipt } from "wagmi";
import type { Address, Hex } from "viem";
import { useActivityLog } from "../store/activityLog";
import { shortAddress } from "../lib/format";

interface DepositArgs {
  to: Address;
  data: Hex;
  value?: bigint;
}

interface SendCallLabels {
  sent: string;
  confirmed: string;
}

/** Generic raw-calldata sender + receipt watcher. Defaults to the escrow
 *  deposit wording; the KYBERSWAP router path reuses it with its own labels
 *  (pass static strings — labels aren't tracked as effect deps). */
export function useDeposit(
  labels: SendCallLabels = {
    sent: "deposit() sent",
    confirmed: "IntentDeposited confirmed",
  }
) {
  const log = useActivityLog((s) => s.push);
  const send = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({ hash: send.data });

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
        to: args.to,
        data: args.data,
        value: args.value ?? 0n,
      }),
    txHash: send.data,
    receipt: receipt.data,
    isPending: send.isPending || receipt.isLoading,
    isSuccess: receipt.isSuccess,
    error: send.error ?? receipt.error,
    reset: send.reset,
  };
}
