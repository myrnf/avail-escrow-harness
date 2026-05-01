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

export function useDeposit() {
  const log = useActivityLog((s) => s.push);
  const send = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({ hash: send.data });

  useEffect(() => {
    if (send.data) {
      log({
        level: "info",
        channel: "TX",
        message: `deposit() sent · ${shortAddress(send.data)}`,
      });
    }
  }, [send.data, log]);

  useEffect(() => {
    if (receipt.isSuccess && send.data) {
      log({
        level: "ok",
        channel: "EVT",
        message: `IntentDeposited confirmed · ${shortAddress(send.data)}`,
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
    isPending: send.isPending || receipt.isLoading,
    isSuccess: receipt.isSuccess,
    error: send.error ?? receipt.error,
    reset: send.reset,
  };
}
