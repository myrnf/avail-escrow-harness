import { erc20Abi } from "../lib/chain/abis";
import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useEffect } from "react";
import type { Address } from "viem";
import { useActivityLog } from "../store/activityLog";
import { shortAddress } from "../lib/format";

export function useTokenBalance(token: Address, owner: Address | undefined) {
  return useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: owner ? [owner] : undefined,
    query: { enabled: !!owner, refetchInterval: 12_000 },
  });
}

export function useTokenAllowance(
  token: Address,
  owner: Address | undefined,
  spender: Address
) {
  return useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: owner ? [owner, spender] : undefined,
    query: { enabled: !!owner, refetchInterval: 8_000 },
  });
}

export function useApprove() {
  const log = useActivityLog((s) => s.push);
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });

  useEffect(() => {
    if (write.data) {
      log({
        level: "info",
        channel: "TX",
        message: `approve() sent · ${shortAddress(write.data)}`,
      });
    }
  }, [write.data, log]);

  useEffect(() => {
    if (receipt.isSuccess && write.data) {
      log({
        level: "ok",
        channel: "CHAIN",
        message: `approve confirmed · ${shortAddress(write.data)}`,
      });
    }
  }, [receipt.isSuccess, write.data, log]);

  return {
    approve: (token: Address, spender: Address, amount: bigint) =>
      write.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, amount],
      }),
    txHash: write.data,
    isPending: write.isPending || receipt.isLoading,
    isSuccess: receipt.isSuccess,
    error: write.error ?? receipt.error,
    reset: write.reset,
  };
}
