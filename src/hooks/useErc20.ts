import { erc20Abi } from "../lib/chain/abis";
import {
  useBalance,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { useEffect } from "react";
import type { Address } from "viem";

import { useActivityLog } from "../store/activityLog";
import { shortAddress } from "../lib/format";
import { useActiveChain } from "./useSession";

// Every read and write below pins `chainId` to the SELECTED chain. Without it
// wagmi follows whatever chain the wallet happens to be on, which across 18
// chains means reading a balance from one chain and approving on another.

export function useTokenBalance(token: Address, owner: Address | undefined) {
  const chain = useActiveChain();
  return useReadContract({
    chainId: chain.id,
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: owner ? [owner] : undefined,
    query: { enabled: !!owner, refetchInterval: 12_000 },
  });
}

/**
 * Balance of `token` for `owner`, normalized to `{ data?: bigint }`.
 * The native asset has no ERC-20 contract (its address is the 0xEeee…
 * sentinel), so we read the chain balance via useBalance; ERC-20s use
 * balanceOf. Both hooks are always called (Rules of Hooks) but gated so only
 * the relevant one fires.
 *
 * `token` is structurally typed so both the KalqiX TokenInfo and the generic
 * ChainToken satisfy it — only the address and nativeness matter here.
 */
export function useInputBalance(
  token: { address: Address; isNative?: boolean },
  owner: Address | undefined
) {
  const chain = useActiveChain();
  const isNative = !!token.isNative;
  const erc20 = useReadContract({
    chainId: chain.id,
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: owner ? [owner] : undefined,
    query: { enabled: !!owner && !isNative, refetchInterval: 12_000 },
  });
  const native = useBalance({
    chainId: chain.id,
    address: owner,
    query: { enabled: !!owner && isNative, refetchInterval: 12_000 },
  });
  return {
    data: isNative
      ? native.data?.value
      : (erc20.data as bigint | undefined),
  };
}

/** `spender` is optional: on chains where the selected venue exposes no
 *  approval address there is nothing to read an allowance against, and the
 *  query stays disabled rather than guessing one. */
export function useTokenAllowance(
  token: Address,
  owner: Address | undefined,
  spender: Address | undefined,
  enabled = true
) {
  const chain = useActiveChain();
  return useReadContract({
    chainId: chain.id,
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: owner && spender ? [owner, spender] : undefined,
    query: { enabled: !!owner && !!spender && enabled, refetchInterval: 8_000 },
  });
}

export function useApprove() {
  const log = useActivityLog((s) => s.push);
  const chain = useActiveChain();
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({
    hash: write.data,
    chainId: chain.id,
  });

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
        chainId: chain.id,
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
