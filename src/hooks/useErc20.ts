import { erc20Abi } from "../lib/chain/abis";
import {
  useBalance,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { useEffect } from "react";
import type { Address } from "viem";
import type { TokenInfo } from "../config/tokens";
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

/**
 * Balance of `token` for `owner`, normalized to `{ data?: bigint }`.
 * Native ETH has no ERC-20 contract (its address is the 0xEeee… sentinel), so
 * we read the chain balance via useBalance; ERC-20s use balanceOf. Both hooks
 * are always called (Rules of Hooks) but gated so only the relevant one fires.
 */
export function useInputBalance(token: TokenInfo, owner: Address | undefined) {
  const isNative = !!token.isNative;
  const erc20 = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: owner ? [owner] : undefined,
    query: { enabled: !!owner && !isNative, refetchInterval: 12_000 },
  });
  const native = useBalance({
    address: owner,
    query: { enabled: !!owner && isNative, refetchInterval: 12_000 },
  });
  return {
    data: isNative
      ? native.data?.value
      : (erc20.data as bigint | undefined),
  };
}

export function useTokenAllowance(
  token: Address,
  owner: Address | undefined,
  spender: Address,
  enabled = true
) {
  return useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: owner ? [owner, spender] : undefined,
    query: { enabled: !!owner && enabled, refetchInterval: 8_000 },
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
