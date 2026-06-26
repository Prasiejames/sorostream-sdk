import { describe, it, expect, vi, beforeEach } from "vitest";
import { SoroStreamClient } from "../src/SoroStreamClient.js";
import type { Stream, WalletAdapter } from "../src/types.js";
import {
  toStroops,
  formatUSDC,
  calculateFlowRate,
  claimableNow,
  timeUntilStreamEnd,
} from "../src/utils.js";
import {
  InsufficientAmountError,
  SoroStreamError,
} from "../src/errors.js";
import { NoopLogger } from "../src/logger.js";
import type { Logger } from "../src/logger.js";

// ── Utility tests ────────────────────────────────────────────────────────────

describe("toStroops", () => {
  it("converts whole USDC to stroops (default 7 decimals)", () => {
    expect(toStroops("100")).toBe(1_000_000_000n);
  });

  it("converts decimal USDC to stroops", () => {
    expect(toStroops("1.5")).toBe(15_000_000n);
  });

  it("handles 7 decimal places", () => {
    expect(toStroops("0.0000001")).toBe(1n);
  });

  it("respects custom decimals parameter", () => {
    expect(toStroops("100", 6)).toBe(100_000_000n);
    expect(toStroops("1.5", 6)).toBe(1_500_000n);
    expect(toStroops("0.5", 18)).toBe(500_000_000_000_000_000n);
  });
});

describe("formatUSDC", () => {
  it("formats stroops to USDC string (default 7 decimals)", () => {
    expect(formatUSDC(1_000_000_000n)).toBe("100.0000000");
  });

  it("formats fractional amounts", () => {
    expect(formatUSDC(1n)).toBe("0.0000001");
  });

  it("formats with no decimal remainder", () => {
    expect(formatUSDC(100_000_000n, 6)).toBe("100.000000");
  });

  it("respects custom decimals parameter", () => {
    expect(formatUSDC(1_500_000n, 6)).toBe("1.500000");
    expect(formatUSDC(1n, 18)).toBe("0.000000000000000001");
  });
});

describe("calculateFlowRate", () => {
  it("calculates flow rate correctly", () => {
    // 100 USDC over 1000 seconds = 1_000_000n stroops/s
    expect(calculateFlowRate(1_000_000_000n, 1000)).toBe(1_000_000n);
  });

  it("throws SoroStreamError on zero duration", () => {
    expect(() => calculateFlowRate(100n, 0)).toThrow(SoroStreamError);
  });
});

describe("claimableNow", () => {
  it("returns 0 for non-active streams", () => {
    const stream: Stream = makeStream({ status: "Cancelled" });
    expect(claimableNow(stream)).toBe(0n);
  });

  it("calculates claimable for active stream", () => {
    const now = Math.floor(Date.now() / 1000);
    const stream: Stream = makeStream({
      status: "Active",
      flowRate: 100n,
      lastWithdrawTime: now - 500,
      endTime: now + 500,
    });
    const claimable = claimableNow(stream);
    // Should be around 500 * 100 = 50_000
    expect(claimable).toBeGreaterThanOrEqual(49_900n);
    expect(claimable).toBeLessThanOrEqual(50_100n);
  });

  it("caps at end time", () => {
    const now = Math.floor(Date.now() / 1000);
    const stream: Stream = makeStream({
      status: "Active",
      flowRate: 100n,
      lastWithdrawTime: now - 2000,
      endTime: now - 1000, // already ended
    });
    // elapsed capped at endTime - lastWithdrawTime = 1000
    expect(claimableNow(stream)).toBe(100_000n);
  });
});

describe("timeUntilStreamEnd", () => {
  it("returns 0 for ended streams", () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({ endTime: now - 100 });
    expect(timeUntilStreamEnd(stream)).toBe(0);
  });

  it("returns positive seconds for active streams", () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({ endTime: now + 3600 });
    expect(timeUntilStreamEnd(stream)).toBeGreaterThan(0);
  });
});

// ── Logger tests ─────────────────────────────────────────────────────────────

describe("NoopLogger", () => {
  it("does not throw when called", () => {
    const logger: Logger = new NoopLogger();
    expect(() => logger.warn("test")).not.toThrow();
    expect(() => logger.error("test")).not.toThrow();
  });
});

// ── SoroStreamClient validation tests ────────────────────────────────────────

describe("SoroStreamClient input validation", () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue("GABC123"),
      signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: "testnet",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      walletAdapter: mockAdapter,
    });
  });

  it("rejects createStream with zero amount (InsufficientAmountError)", async () => {
    await expect(
      client.createStream({
        recipient: "GABC",
        token: "GUSDC",
        amount: 0n,
        durationSeconds: 1000,
        autoRenew: false,
      })
    ).rejects.toThrow(InsufficientAmountError);
  });

  it("rejects createStream with zero duration", async () => {
    await expect(
      client.createStream({
        recipient: "GABC",
        token: "GUSDC",
        amount: 100n,
        durationSeconds: 0,
        autoRenew: false,
      })
    ).rejects.toThrow("Duration must be > 0");
  });

  it("rejects topUp with zero amount (InsufficientAmountError)", async () => {
    await expect(
      client.topUp({ streamId: "1", amount: 0n })
    ).rejects.toThrow(InsufficientAmountError);
  });
});

// ── Typed error tests ────────────────────────────────────────────────────────

describe("typed errors", () => {
  it("InsufficientAmountError extends SoroStreamError", () => {
    const err = new InsufficientAmountError();
    expect(err).toBeInstanceOf(SoroStreamError);
    expect(err.message).toBe("Amount must be > 0");
  });

  it("InsufficientAmountError accepts custom message", () => {
    const err = new InsufficientAmountError("Custom");
    expect(err.message).toBe("Custom");
  });

  it("SoroStreamError is a base Error", () => {
    const err = new SoroStreamError("base");
    expect(err).toBeInstanceOf(Error);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStream(overrides: Partial<Stream> = {}): Stream {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: "0",
    sender: "GSENDER",
    recipient: "GRECIPIENT",
    token: "GTOKEN",
    deposit: 100_000n,
    flowRate: 100n,
    startTime: now,
    endTime: now + 1000,
    lastWithdrawTime: now,
    status: "Active",
    autoRenew: false,
    ...overrides,
  };
}
