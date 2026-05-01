import { formatUnits, parseUnits } from "viem";

/**
 * Format a base-unit BigInt as a fixed-decimal display string with thousands
 * separators. Trims trailing zeros past `minDp` decimals.
 */
export function fmtAmount(
  value: bigint,
  decimals: number,
  opts: { minDp?: number; maxDp?: number } = {}
): string {
  const { minDp = 2, maxDp = 8 } = opts;
  const raw = formatUnits(value, decimals);
  const [whole, frac = ""] = raw.split(".");
  let trimmed = frac.slice(0, maxDp);
  while (trimmed.length > minDp && trimmed.endsWith("0")) {
    trimmed = trimmed.slice(0, -1);
  }
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return trimmed.length > 0 ? `${grouped}.${trimmed}` : grouped;
}

/** Parse a user input string ("1,000.50") to base units of `decimals`. */
export function parseAmount(input: string, decimals: number): bigint {
  const cleaned = input.replace(/,/g, "").trim();
  if (!cleaned) return 0n;
  return parseUnits(cleaned, decimals);
}

export function shortAddress(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function shortHash(hash: string): string {
  return shortAddress(hash);
}
