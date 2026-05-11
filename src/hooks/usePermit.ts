import type { Address, Hex } from "viem";
import {
  encodeAbiParameters,
  hashTypedData,
  parseSignature,
  recoverAddress,
} from "viem";
import { useAccount, usePublicClient, useSignTypedData } from "wagmi";
import { useActiveNetwork } from "./useActiveNetwork";
import { useActivityLog } from "../store/activityLog";
import type { TokenInfo } from "../config/tokens";

const eip712DomainAbi = [
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

const permitReadAbi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

interface CollectPermitInput {
  token: TokenInfo;
  spender: Address;
  value: bigint;
  deadline: bigint;
}

/**
 * Collects an EIP-2612 permit signature and returns it ABI-encoded as exactly
 * 128 bytes in the layout the Avail Escrow contract expects:
 *
 *   abi.encode(uint256 deadline, uint8 v, bytes32 r, bytes32 s)
 *
 * The contract supplies owner = msg.sender, spender = address(this), value =
 * amountIn itself — so they're not in the blob.
 *
 * Domain resolution: prefer EIP-5267's eip712Domain() (returns the full domain
 * the contract actually uses for signature verification). Fall back to reading
 * name() and using TokenInfo.permitDomainVersion if the contract doesn't
 * implement 5267.
 */
export function usePermit() {
  const { address: owner } = useAccount();
  const network = useActiveNetwork();
  const publicClient = usePublicClient({ chainId: network.chain.id });
  const { signTypedDataAsync } = useSignTypedData();
  const log = useActivityLog((s) => s.push);

  async function collectPermit(input: CollectPermitInput): Promise<Hex> {
    if (!owner) throw new Error("Wallet not connected");
    if (!publicClient) throw new Error("Public client unavailable for the active network");

    const { token, spender, value, deadline } = input;

    let domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: Address;
    };
    try {
      const res = await publicClient.readContract({
        address: token.address,
        abi: eip712DomainAbi,
        functionName: "eip712Domain",
      });
      domain = {
        name: res[1],
        version: res[2],
        chainId: Number(res[3]),
        verifyingContract: res[4],
      };
    } catch {
      const name = await publicClient.readContract({
        address: token.address,
        abi: permitReadAbi,
        functionName: "name",
      });
      domain = {
        name,
        version: token.permitDomainVersion,
        chainId: network.chain.id,
        verifyingContract: token.address,
      };
    }

    const nonce = await publicClient.readContract({
      address: token.address,
      abi: permitReadAbi,
      functionName: "nonces",
      args: [owner],
    });

    const permitTypes = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    } as const;
    const permitMessage = { owner, spender, value, nonce, deadline };

    const t0 = performance.now();
    const signature = await signTypedDataAsync({
      domain,
      types: permitTypes,
      primaryType: "Permit",
      message: permitMessage,
    });

    // Local verification: rebuild the digest we just signed and recover the
    // address. If recovery mismatches, our domain/types/message construction
    // doesn't match what the token contract will recompute on-chain. The
    // contract's try/catch swallows permit reverts, so this is our only way to
    // surface a signing bug before submission.
    const digest = hashTypedData({
      domain,
      types: permitTypes,
      primaryType: "Permit",
      message: permitMessage,
    });
    const recovered = await recoverAddress({ hash: digest, signature });
    if (recovered.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(
        `Permit signature recovery mismatch: signed digest recovers to ${recovered}, expected owner ${owner}. Domain/types may not match the token contract — check name="${domain.name}" version="${domain.version}" chainId=${domain.chainId}.`
      );
    }

    const parsed = parseSignature(signature);
    // Wallets may return v as 27/28 (legacy) or yParity as 0/1 (modern).
    // EIP-2612 token contracts expect uint8 v ∈ {27, 28}; normalize to that form.
    let v: number;
    if (parsed.v !== undefined) {
      const n = Number(parsed.v);
      v = n < 27 ? n + 27 : n;
    } else if (parsed.yParity !== undefined) {
      v = parsed.yParity + 27;
    } else {
      throw new Error("Signature missing v / yParity");
    }

    const permitBytes = encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint8" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [deadline, v, parsed.r, parsed.s]
    );

    log({
      level: "ok",
      channel: "SIG",
      message: `EIP-2612 permit signed · ${token.symbol}`,
      details: `${Math.round(performance.now() - t0)}ms · domain "${domain.name}" v${domain.version}`,
    });

    return permitBytes;
  }

  return { collectPermit };
}
