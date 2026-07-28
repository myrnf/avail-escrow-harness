import { erc20Abi, parseEventLogs } from "viem";
import type { Address, TransactionReceipt } from "viem";

/**
 * Sum the tokenOut actually delivered to `user` in a swap receipt, from its
 * ERC-20 Transfer logs. Returns null when it can't be derived: no receipt,
 * native-ETH output (the router unwraps WETH — no Transfer to the user), or
 * no matching logs.
 */
export function receiptAmountOut(
  receipt: TransactionReceipt | undefined,
  token: { address: Address; isNative?: boolean },
  user: Address | undefined
): bigint | null {
  if (!receipt || !user || token.isNative) return null;
  try {
    const transfers = parseEventLogs({
      abi: erc20Abi,
      eventName: "Transfer",
      logs: receipt.logs,
    });
    let total = 0n;
    let seen = false;
    for (const t of transfers) {
      if (t.address.toLowerCase() !== token.address.toLowerCase()) continue;
      if (t.args.to.toLowerCase() !== user.toLowerCase()) continue;
      total += t.args.value;
      seen = true;
    }
    return seen ? total : null;
  } catch {
    return null;
  }
}
