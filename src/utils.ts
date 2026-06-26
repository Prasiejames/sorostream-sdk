import type { Stream } from "./types.js";
import { SoroStreamError } from "./errors.js";

/**
 * Converts a token amount (as a decimal string like "100.50") to stroops/smallest unit.
 * @param amount - Amount as a decimal string.
 * @param decimals - Number of decimal places the token uses (default 7 for SAC).
 */
export function toStroops(amount: string, decimals: number = 7): bigint {
  const [whole = "0", decimal = ""] = amount.split(".");
  const factor = 10n ** BigInt(decimals);
  const paddedDecimal = decimal.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole) * factor + BigInt(paddedDecimal);
}

/**
 * Formats a stroop amount to a human-readable token string (e.g. "100.5000000").
 * @param stroops - Amount in the smallest token unit.
 * @param decimals - Number of decimal places the token uses (default 7 for SAC).
 */
export function formatUSDC(stroops: bigint, decimals: number = 7): string {
  const factor = 10n ** BigInt(decimals);
  const whole = stroops / factor;
  const remainder = stroops % factor;
  return `${whole}.${remainder.toString().padStart(decimals, "0")}`;
}

/**
 * Calculates the per-second flow rate in stroops.
 * @param amount - Total amount in stroops.
 * @param durationSeconds - Duration in seconds.
 */
export function calculateFlowRate(amount: bigint, durationSeconds: number): bigint {
  if (durationSeconds <= 0) throw new SoroStreamError("Duration must be > 0");
  return amount / BigInt(durationSeconds);
}

/**
 * Returns the number of seconds remaining until the stream ends.
 * Returns 0 if the stream has already ended.
 * @param stream - The stream object.
 */
export function timeUntilStreamEnd(stream: Stream): number {
  const now = Math.floor(Date.now() / 1000);
  return Math.max(0, stream.endTime - now);
}

/**
 * Calculates the currently claimable amount in stroops based on local time.
 * This is an estimate — the contract is the source of truth.
 * @param stream - The stream object.
 */
export function claimableNow(stream: Stream): bigint {
  if (stream.status !== "Active") return 0n;
  const now = Math.floor(Date.now() / 1000);
  const effectiveNow = Math.min(now, stream.endTime);
  const elapsed = Math.max(0, effectiveNow - stream.lastWithdrawTime);
  return stream.flowRate * BigInt(elapsed);
}
