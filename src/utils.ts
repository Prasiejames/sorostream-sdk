import type { Stream, BulkStreamRow, TokenAggregate } from "./types.js";

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
 * Groups streams by token address and returns per-token aggregates.
 * Uses the client-side `claimableNow` for claimable estimates.
 *
 * @param streams - Stream list (e.g. from getStreamsByRecipient).
 * @returns Per-token aggregates sorted by deposited amount descending.
 *
 * @example
 * ```ts
 * const streams = await client.getStreamsByRecipient(recipient);
 * const agg = aggregateStreamsByToken(streams);
 * for (const t of agg) console.log(t.token, t.claimable);
 * ```
 */
export function aggregateStreamsByToken(streams: Stream[]): TokenAggregate[] {
  const map = new Map<string, TokenAggregate>();

  for (const s of streams) {
    const existing = map.get(s.token) ?? {
      token: s.token,
      streamCount: 0,
      deposited: 0n,
      claimable: 0n,
      claimedSoFar: 0n,
    };
    existing.streamCount += 1;
    existing.deposited += s.deposit;
    existing.claimable += claimableNow(s);
    existing.claimedSoFar += s.deposit - s.flowRate * BigInt(s.endTime - s.lastWithdrawTime);
    map.set(s.token, existing);
  }

  return [...map.values()].sort((a, b) => {
    if (b.deposited > a.deposited) return 1;
    if (b.deposited < a.deposited) return -1;
    return 0;
  });
}

/**
 * Parses a CSV string into BulkStreamRow objects.
 *
 * Expected CSV format (header required):
 * ```
 * recipient,amount,durationSeconds
 * GABCD...1,10000000,2592000
 * GABCD...2,5000000,604800
 * ```
 *
 * `amount` is in stroops (bigint-compatible string).
 *
 * @param csv - The CSV content with header row.
 * @returns Parsed rows.
 */
export function parseCsvStreamRows(csv: string): BulkStreamRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("CSV must have a header row and at least one data row");

  const header = lines[0].toLowerCase().trim();
  const cols = header.split(",").map((c) => c.trim());

  const recipientIdx = cols.indexOf("recipient");
  const amountIdx = cols.indexOf("amount");
  const durationIdx = cols.indexOf("durationseconds");

  if (recipientIdx === -1) throw new Error("CSV missing 'recipient' column");
  if (amountIdx === -1) throw new Error("CSV missing 'amount' column");
  if (durationIdx === -1) throw new Error("CSV missing 'durationSeconds' column");

  const rows: BulkStreamRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = line.split(",").map((f) => f.trim());

    const recipient = fields[recipientIdx];
    if (!recipient) throw new Error(`Row ${i + 1}: missing recipient`);

    const amount = BigInt(fields[amountIdx]);
    const durationSeconds = Number(fields[durationIdx]);

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error(`Row ${i + 1}: invalid durationSeconds`);
    }

    rows.push({ recipient, amount, durationSeconds });
  }

  return rows;
}
