import {
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  rpc,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  CancelStreamParams,
  CreateStreamParams,
  Network,
  Stream,
  SoroStreamClientOptions,
  TopUpParams,
  WalletAdapter,
  WithdrawParams,
} from "./types.js";
import { Cache } from "./cache.js";
import { RateLimiter } from "./rate-limiter.js";
import { Telemetry } from "./telemetry.js";

const RPC_URLS: Record<Network, string> = {
  mainnet: "https://soroban.stellar.org",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

/** Maps a raw Soroban contract value to a Stream object. */
function scValToStream(val: xdr.ScVal): Stream {
  const raw = scValToNative(val) as Record<string, unknown>;
  return {
    id: String(raw["id"]),
    sender: String(raw["sender"]),
    recipient: String(raw["recipient"]),
    token: String(raw["token"]),
    deposit: BigInt(raw["deposit"] as number),
    flowRate: BigInt(raw["flow_rate"] as number),
    startTime: Number(raw["start_time"]),
    endTime: Number(raw["end_time"]),
    lastWithdrawTime: Number(raw["last_withdraw_time"]),
    status: raw["status"] as Stream["status"],
    autoRenew: Boolean(raw["auto_renew"]),
  };
}

/**
 * Main client for interacting with the SoroStream contract.
 *
 * @example
 * ```ts
 * const client = new SoroStreamClient({ network: "testnet", contractId: "...", walletAdapter });
 * const { streamId } = await client.createStream({ recipient, token, amount, durationSeconds, autoRenew });
 * ```
 */
export class SoroStreamClient {
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly network: Network;
  private readonly walletAdapter: WalletAdapter;
  private readonly cache: Cache<string, unknown>;
  private readonly rateLimiter: RateLimiter;
  private readonly telemetry: Telemetry;
  private readonly cacheTtlMs: number;

  constructor(options: SoroStreamClientOptions) {
    this.network = options.network;
    this.walletAdapter = options.walletAdapter;
    this.contract = new Contract(options.contractId);
    this.server = new rpc.Server(options.rpcUrl ?? RPC_URLS[options.network], {
      allowHttp: false,
    });
    this.cacheTtlMs = options.cacheTtlMs ?? 0;
    this.cache = new Cache(this.cacheTtlMs || 60_000);
    this.rateLimiter = new RateLimiter(options.maxConcurrentRpc ?? 10);
    this.telemetry = new Telemetry(options.telemetry ?? false);
  }

  /**
   * Clear all cached entries. Only meaningful when caching is enabled.
   */
  clearCache(): void {
    this.cache.clear();
  }

  private cacheKey(prefix: string, id: string): string {
    return `${prefix}:${id}`;
  }

  private async withCached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.cacheTtlMs <= 0) return fn();
    const cached = this.cache.get(key) as T | undefined;
    if (cached !== undefined) return cached;
    const result = await fn();
    this.cache.set(key, result);
    return result;
  }

  private async rpcCall<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const span = this.telemetry.startSpan(`sorostream.rpc.${name}`);
    try {
      const result = await this.rateLimiter.run(fn);
      this.telemetry.endSpan(span);
      return result;
    } catch (err) {
      this.telemetry.recordError(span, err instanceof Error ? err : new Error(String(err)));
      this.telemetry.endSpan(span);
      throw err;
    }
  }

  private async buildAndSubmit(operation: xdr.Operation): Promise<string> {
    const span = this.telemetry.startSpan("sorostream.buildAndSubmit");

    try {
      const publicKey = await this.walletAdapter.getPublicKey();
      const account = await this.rpcCall("getAccount", () =>
        this.server.getAccount(publicKey)
      );

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASES[this.network],
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const preparedTx = await this.rpcCall("prepareTransaction", () =>
        this.server.prepareTransaction(tx)
      );

      const signedXdr = await this.walletAdapter.signTransaction(
        preparedTx.toXDR(),
        this.network
      );

      const result = await this.rpcCall("sendTransaction", () =>
        this.server.sendTransaction(
          TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASES[this.network])
        )
      );

      if (result.status === "ERROR") {
        throw new Error(`Transaction failed: ${JSON.stringify(result.errorResult)}`);
      }

      let response = await this.rpcCall("getTransaction", () =>
        this.server.getTransaction(result.hash)
      );
      while (response.status === "NOT_FOUND") {
        await new Promise((r) => setTimeout(r, 1000));
        response = await this.rpcCall("getTransaction", () =>
          this.server.getTransaction(result.hash)
        );
      }

      if (response.status === "FAILED") {
        throw new Error(`Transaction failed: ${result.hash}`);
      }

      this.telemetry.endSpan(span, { "sorostream.txHash": result.hash });
      return result.hash;
    } catch (err) {
      this.telemetry.recordError(span, err instanceof Error ? err : new Error(String(err)));
      this.telemetry.endSpan(span);
      throw err;
    }
  }

  /**
   * Creates a new payment stream.
   * @param params - Stream creation parameters.
   * @returns The new stream ID and transaction hash.
   */
  async createStream(
    params: CreateStreamParams
  ): Promise<{ streamId: string; txHash: string }> {
    const span = this.telemetry.startSpan("sorostream.createStream");

    try {
      if (params.amount <= 0n) throw new Error("Amount must be > 0");
      if (params.durationSeconds <= 0) throw new Error("Duration must be > 0");

      const sender = await this.walletAdapter.getPublicKey();

      const operation = this.contract.call(
        "create_stream",
        nativeToScVal(sender, { type: "address" }),
        nativeToScVal(params.recipient, { type: "address" }),
        nativeToScVal(params.token, { type: "address" }),
        nativeToScVal(params.amount, { type: "i128" }),
        nativeToScVal(params.durationSeconds, { type: "u64" }),
        nativeToScVal(params.autoRenew, { type: "bool" })
      );

      const txHash = await this.buildAndSubmit(operation);

      // Invalidate sender caches
      this.cache.delete(this.cacheKey("sender", sender));
      this.cache.delete(this.cacheKey("recipient", params.recipient));

      const streams = await this.getStreamsBySender(sender);
      const latest = streams[streams.length - 1];
      if (!latest) throw new Error("Stream not found after creation");

      this.telemetry.endSpan(span, {
        "sorostream.streamId": latest.id,
        "sorostream.txHash": txHash,
      });
      return { streamId: latest.id, txHash };
    } catch (err) {
      this.telemetry.recordError(span, err instanceof Error ? err : new Error(String(err)));
      this.telemetry.endSpan(span);
      throw err;
    }
  }

  /**
   * Withdraws all currently claimable tokens from a stream.
   * @param params - Withdraw parameters.
   * @returns The transaction hash and withdrawn amount.
   */
  async withdraw(params: WithdrawParams): Promise<{ txHash: string; amount: string }> {
    const span = this.telemetry.startSpan("sorostream.withdraw");

    try {
      const recipient = await this.walletAdapter.getPublicKey();
      const claimable = await this.getClaimable(params.streamId);

      const operation = this.contract.call(
        "withdraw",
        nativeToScVal(BigInt(params.streamId), { type: "u64" }),
        nativeToScVal(recipient, { type: "address" })
      );

      const txHash = await this.buildAndSubmit(operation);

      // Invalidate caches
      this.cache.delete(this.cacheKey("claimable", params.streamId));
      this.cache.delete(this.cacheKey("stream", params.streamId));

      this.telemetry.endSpan(span, {
        "sorostream.txHash": txHash,
        "sorostream.streamId": params.streamId,
      });
      return { txHash, amount: claimable.toString() };
    } catch (err) {
      this.telemetry.recordError(span, err instanceof Error ? err : new Error(String(err)));
      this.telemetry.endSpan(span);
      throw err;
    }
  }

  /**
   * Cancels an active stream. Refunds unstreamed tokens to sender.
   * @param params - Cancel parameters.
   * @returns The transaction hash.
   */
  async cancelStream(params: CancelStreamParams): Promise<{ txHash: string }> {
    const span = this.telemetry.startSpan("sorostream.cancelStream");

    try {
      const sender = await this.walletAdapter.getPublicKey();

      const operation = this.contract.call(
        "cancel_stream",
        nativeToScVal(BigInt(params.streamId), { type: "u64" }),
        nativeToScVal(sender, { type: "address" })
      );

      const txHash = await this.buildAndSubmit(operation);

      // Invalidate caches
      this.cache.delete(this.cacheKey("stream", params.streamId));
      this.cache.delete(this.cacheKey("claimable", params.streamId));

      this.telemetry.endSpan(span, {
        "sorostream.txHash": txHash,
        "sorostream.streamId": params.streamId,
      });
      return { txHash };
    } catch (err) {
      this.telemetry.recordError(span, err instanceof Error ? err : new Error(String(err)));
      this.telemetry.endSpan(span);
      throw err;
    }
  }

  /**
   * Tops up an existing stream with additional tokens, extending its duration.
   * @param params - Top-up parameters.
   * @returns The transaction hash and new end time.
   */
  async topUp(params: TopUpParams): Promise<{ txHash: string; newEndTime: Date }> {
    const span = this.telemetry.startSpan("sorostream.topUp");

    try {
      if (params.amount <= 0n) throw new Error("Amount must be > 0");
      const sender = await this.walletAdapter.getPublicKey();

      const operation = this.contract.call(
        "top_up",
        nativeToScVal(BigInt(params.streamId), { type: "u64" }),
        nativeToScVal(sender, { type: "address" }),
        nativeToScVal(params.amount, { type: "i128" })
      );

      const txHash = await this.buildAndSubmit(operation);

      // Invalidate caches
      this.cache.delete(this.cacheKey("stream", params.streamId));

      const stream = await this.getStream(params.streamId);

      this.telemetry.endSpan(span, {
        "sorostream.txHash": txHash,
        "sorostream.streamId": params.streamId,
      });
      return { txHash, newEndTime: new Date(stream.endTime * 1000) };
    } catch (err) {
      this.telemetry.recordError(span, err instanceof Error ? err : new Error(String(err)));
      this.telemetry.endSpan(span);
      throw err;
    }
  }

  /**
   * Returns the full stream data for a given stream ID.
   * @param streamId - The stream ID to look up.
   */
  async getStream(streamId: string): Promise<Stream> {
    return this.withCached(this.cacheKey("stream", streamId), async () => {
      const span = this.telemetry.startSpan("sorostream.getStream");

      try {
        const result = await this.rpcCall("simulateTransaction", () =>
          this.server.simulateTransaction(
            new TransactionBuilder(
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              await this.server.getAccount(await this.walletAdapter.getPublicKey()),
              { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASES[this.network] }
            )
              .addOperation(
                this.contract.call(
                  "get_stream",
                  nativeToScVal(BigInt(streamId), { type: "u64" })
                )
              )
              .setTimeout(30)
              .build()
          )
        );

        if (rpc.Api.isSimulationError(result)) {
          throw new Error(`Stream not found: ${streamId}`);
        }

        const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
        if (!returnVal) throw new Error("No return value from contract");

        const stream = scValToStream(returnVal);
        this.telemetry.endSpan(span, { "sorostream.streamId": streamId });
        return stream;
      } catch (err) {
        this.telemetry.recordError(span, err instanceof Error ? err : new Error(String(err)));
        this.telemetry.endSpan(span);
        throw err;
      }
    });
  }

  /**
   * Returns the currently claimable amount in stroops for a stream.
   * @param streamId - The stream ID to check.
   */
  async getClaimable(streamId: string): Promise<bigint> {
    return this.withCached(this.cacheKey("claimable", streamId), async () => {
      const span = this.telemetry.startSpan("sorostream.getClaimable");

      try {
        const result = await this.rpcCall("simulateTransaction", () =>
          this.server.simulateTransaction(
            new TransactionBuilder(
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              await this.server.getAccount(await this.walletAdapter.getPublicKey()),
              { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASES[this.network] }
            )
              .addOperation(
                this.contract.call(
                  "get_claimable",
                  nativeToScVal(BigInt(streamId), { type: "u64" })
                )
              )
              .setTimeout(30)
              .build()
          )
        );

        if (rpc.Api.isSimulationError(result)) return 0n;

        const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
        if (!returnVal) return 0n;

        const value = BigInt(scValToNative(returnVal) as number);
        this.telemetry.endSpan(span, { "sorostream.streamId": streamId });
        return value;
      } catch (err) {
        this.telemetry.recordError(span, err instanceof Error ? err : new Error(String(err)));
        this.telemetry.endSpan(span);
        throw err;
      }
    });
  }

  /**
   * Returns all streams created by a sender address.
   * @param sender - The sender address to query.
   */
  async getStreamsBySender(sender: string): Promise<Stream[]> {
    return this.withCached(this.cacheKey("sender", sender), async () => {
      const span = this.telemetry.startSpan("sorostream.getStreamsBySender");

      try {
        const result = await this.rpcCall("simulateTransaction", () =>
          this.server.simulateTransaction(
            new TransactionBuilder(
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              await this.server.getAccount(await this.walletAdapter.getPublicKey()),
              { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASES[this.network] }
            )
              .addOperation(
                this.contract.call(
                  "get_streams_by_sender",
                  nativeToScVal(sender, { type: "address" })
                )
              )
              .setTimeout(30)
              .build()
          )
        );

        if (rpc.Api.isSimulationError(result)) return [];

        const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
        if (!returnVal) return [];

        const raw = scValToNative(returnVal) as xdr.ScVal[];
        const streams = raw.map(scValToStream);
        this.telemetry.endSpan(span);
        return streams;
      } catch (err) {
        this.telemetry.recordError(span, err instanceof Error ? err : new Error(String(err)));
        this.telemetry.endSpan(span);
        throw err;
      }
    });
  }

  /**
   * Returns all streams targeting a recipient address.
   * @param recipient - The recipient address to query.
   */
  async getStreamsByRecipient(recipient: string): Promise<Stream[]> {
    return this.withCached(this.cacheKey("recipient", recipient), async () => {
      const span = this.telemetry.startSpan("sorostream.getStreamsByRecipient");

      try {
        const result = await this.rpcCall("simulateTransaction", () =>
          this.server.simulateTransaction(
            new TransactionBuilder(
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              await this.server.getAccount(await this.walletAdapter.getPublicKey()),
              { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASES[this.network] }
            )
              .addOperation(
                this.contract.call(
                  "get_streams_by_recipient",
                  nativeToScVal(recipient, { type: "address" })
                )
              )
              .setTimeout(30)
              .build()
          )
        );

        if (rpc.Api.isSimulationError(result)) return [];

        const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
        if (!returnVal) return [];

        const raw = scValToNative(returnVal) as xdr.ScVal[];
        const streams = raw.map(scValToStream);
        this.telemetry.endSpan(span);
        return streams;
      } catch (err) {
        this.telemetry.recordError(span, err instanceof Error ? err : new Error(String(err)));
        this.telemetry.endSpan(span);
        throw err;
      }
    });
  }
}
