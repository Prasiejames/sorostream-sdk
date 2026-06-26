import type { Stream } from "./types.js";

/** A single point in a stream's payout forecast. */
export interface PayoutSchedulePoint {
  /** Unix timestamp (seconds) for this sample. */
  timestamp: number;
  /** Cumulative tokens claimable from stream start up to `timestamp`, in stroops. */
  cumulativeClaimable: bigint;
}

const STROOP_FACTOR = 10_000_000n;

/**
 * Converts a USDC amount (as a decimal string like "100.50") to stroops.
 * @param usdc - USDC amount as a decimal string.
 */
export function toStroops(usdc: string): bigint {
  const [whole = "0", decimal = ""] = usdc.split(".");
  const paddedDecimal = decimal.padEnd(7, "0").slice(0, 7);
  return BigInt(whole) * STROOP_FACTOR + BigInt(paddedDecimal);
}

/**
 * Formats a stroop amount to a human-readable USDC string (e.g. "100.5000000").
 * @param stroops - Amount in stroops.
 */
export function formatUSDC(stroops: bigint): string {
  const whole = stroops / STROOP_FACTOR;
  const remainder = stroops % STROOP_FACTOR;
  return `${whole}.${remainder.toString().padStart(7, "0")}`;
}

/**
 * Calculates the per-second flow rate in stroops.
 * @param amount - Total amount in stroops.
 * @param durationSeconds - Duration in seconds.
 */
export function calculateFlowRate(amount: bigint, durationSeconds: number): bigint {
  if (durationSeconds <= 0) throw new Error("Duration must be > 0");
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

/**
 * Returns an array of `pointCount` evenly-spaced `{timestamp, cumulativeClaimable}`
 * samples across the stream's full lifetime (`startTime` → `endTime`).
 *
 * Suitable for rendering line charts in `FlowRatePreview` and `StreamTimeline`
 * components without needing additional RPC calls.
 *
 * - The first point is always at `stream.startTime` with `cumulativeClaimable = 0n`.
 * - The last point is always at `stream.endTime` with `cumulativeClaimable = stream.deposit`.
 * - For Cancelled or Completed streams, points after the last withdrawal time
 *   are clamped to the amount earned at that point.
 *
 * @param stream - The stream to forecast.
 * @param pointCount - Number of sample points to return (minimum 2).
 */
export function getPayoutSchedule(stream: Stream, pointCount: number): PayoutSchedulePoint[] {
  const count = Math.max(2, Math.floor(pointCount));
  const { startTime, endTime, flowRate, deposit, status, lastWithdrawTime } = stream;

  // For non-active streams the effective end is the last withdrawal.
  const effectiveEnd = status === "Active" ? endTime : Math.min(lastWithdrawTime, endTime);
  const totalDuration = endTime - startTime;

  const points: PayoutSchedulePoint[] = [];

  for (let i = 0; i < count; i++) {
    const fraction = i / (count - 1);
    const timestamp = Math.round(startTime + fraction * totalDuration);
    const elapsed = Math.max(0, Math.min(timestamp, effectiveEnd) - startTime);
    const cumulative =
      elapsed >= totalDuration ? deposit : flowRate * BigInt(elapsed);
    points.push({ timestamp, cumulativeClaimable: cumulative });
  }

  return points;
}
