import { erc20Abi, getAddress, isAddress } from "viem";
import type { Address, PublicClient } from "viem";
import type { ChainToken } from "./types";

export class TokenResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenResolveError";
  }
}

/**
 * Resolve an arbitrary ERC-20 by reading its metadata on-chain. This is the
 * path that demonstrates the API's "any token, not just the ones we list"
 * claim — and on chains Kyber's token list doesn't serve, it's the only path.
 *
 * `symbol`/`name` are read best-effort: some tokens return bytes32 rather than
 * string and will revert against the standard ABI. `decimals` is not
 * best-effort — without it every amount on screen would be wrong, so a failure
 * there rejects the token.
 */
export async function resolveTokenOnchain(
  client: PublicClient,
  chainId: number,
  raw: string
): Promise<ChainToken> {
  const trimmed = raw.trim();
  if (!isAddress(trimmed)) {
    throw new TokenResolveError("Not a valid EVM address");
  }
  // Checksum it: Avail lowercases for its registry, but the checksummed form is
  // what we show and what viem expects.
  const address = getAddress(trimmed) as Address;

  const [decimals, symbol, name] = await Promise.all([
    client.readContract({
      address,
      abi: erc20Abi,
      functionName: "decimals",
    }) as Promise<number>,
    client
      .readContract({ address, abi: erc20Abi, functionName: "symbol" })
      .catch(() => null) as Promise<string | null>,
    client
      .readContract({ address, abi: erc20Abi, functionName: "name" })
      .catch(() => null) as Promise<string | null>,
  ]).catch((e) => {
    throw new TokenResolveError(
      `No ERC-20 at that address on this chain (${
        e instanceof Error ? e.message.split("\n")[0] : "read failed"
      })`
    );
  });

  if (typeof decimals !== "number") {
    throw new TokenResolveError("Contract did not return decimals()");
  }

  return {
    chainId,
    address,
    symbol: symbol || `${address.slice(0, 6)}…`,
    name: name || "Unknown token",
    decimals,
    source: "custom",
  };
}
