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
  CreateStreamsParams,
  Network,
  Stream,
  TopUpParams,
  WalletAdapter,
  WithdrawParams,
  WriteOptions,
  CircuitBreakerOptions as CircuitBreakerOptionsType,
} from "./types.js";
import { CircuitBreaker } from "./circuitBreaker.js";

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

/** Options for constructing a SoroStreamClient. */
export interface SoroStreamClientOptions {
  /** The Stellar network to connect to. */
  network: Network;
  /** The deployed StreamContract address. */
  contractId: string;
  /** Wallet adapter for signing transactions. */
  walletAdapter: WalletAdapter;
  /** Optional custom RPC URL (overrides default). */
  rpcUrl?: string;
  /** Optional circuit-breaker configuration for RPC calls. */
  circuitBreaker?: CircuitBreakerOptionsType;
}

/** Maps a raw Soroban contract value to a Stream object. */
function scValToStream(val: xdr.ScVal): Stream {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = scValToNative(val) as Record<string, any>;
  return {
    id: String(raw["id"]),
    sender: String(raw["sender"]),
    recipient: String(raw["recipient"]),
    token: String(raw["token"]),
    deposit: BigInt(raw["deposit"]),
    flowRate: BigInt(raw["flow_rate"]),
    startTime: Number(raw["start_time"]),
    endTime: Number(raw["end_time"]),
    lastWithdrawTime: Number(raw["last_withdraw_time"]),
    status: raw["status"] as Stream["status"],
    autoRenew: Boolean(raw["auto_renew"]),
  };
}

export type SimulateOnlyResult = {
  simulated: true;
  result: rpc.Api.SimulateTransactionResponse;
};

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
  private readonly breaker: CircuitBreaker | null;

  constructor(options: SoroStreamClientOptions) {
    this.network = options.network;
    this.walletAdapter = options.walletAdapter;
    this.contract = new Contract(options.contractId);
    this.server = new rpc.Server(options.rpcUrl ?? RPC_URLS[options.network], {
      allowHttp: false,
    });
    this.breaker = options.circuitBreaker
      ? new CircuitBreaker(options.circuitBreaker)
      : null;
  }

  private async withBreaker<T>(fn: () => Promise<T>): Promise<T> {
    if (this.breaker) {
      return this.breaker.call(fn);
    }
    return fn();
  }

  private async buildAndSubmit(operations: xdr.Operation[]): Promise<string> {
    const publicKey = await this.walletAdapter.getPublicKey();
    const account = await this.withBreaker(() => this.server.getAccount(publicKey));

    let builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASES[this.network],
    });
    for (const op of operations) {
      builder = builder.addOperation(op);
    }
    const tx = builder.setTimeout(30).build();

    const preparedTx = await this.withBreaker(() =>
      this.server.prepareTransaction(tx)
    );
    const signedXdr = await this.walletAdapter.signTransaction(
      preparedTx.toXDR(),
      this.network
    );

    const result = await this.withBreaker(() =>
      this.server.sendTransaction(
        TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASES[this.network])
      )
    );

    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(result.errorResult)}`);
    }

    let response = await this.withBreaker(() =>
      this.server.getTransaction(result.hash)
    );
    while (response.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      response = await this.withBreaker(() =>
        this.server.getTransaction(result.hash)
      );
    }

    if (response.status === "FAILED") {
      throw new Error(`Transaction failed: ${result.hash}`);
    }

    return result.hash;
  }

  private async simulateOp(
    operation: xdr.Operation
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    const publicKey = await this.walletAdapter.getPublicKey();
    const account = await this.withBreaker(() => this.server.getAccount(publicKey));
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASES[this.network],
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();
    return this.withBreaker(() => this.server.simulateTransaction(tx));
  }

  /**
   * Creates a new payment stream.
   * @param params - Stream creation parameters.
   * @param options - Optional write options (e.g. simulateOnly).
   * @returns The new stream ID and transaction hash, or simulation result.
   */
  async createStream(
    params: CreateStreamParams,
    options?: WriteOptions
  ): Promise<
    { streamId: string; txHash: string } | SimulateOnlyResult
  > {
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

    if (options?.simulateOnly) {
      const result = await this.simulateOp(operation);
      return { simulated: true, result };
    }

    const txHash = await this.buildAndSubmit([operation]);

    const streams = await this.getStreamsBySender(sender);
    const latest = streams[streams.length - 1];
    if (!latest) throw new Error("Stream not found after creation");

    return { streamId: latest.id, txHash };
  }

  /**
   * Creates multiple payment streams in a single transaction.
   * @param paramsArray - Array of stream creation parameters.
   * @param options - Optional write options (e.g. simulateOnly).
   * @returns Array of stream IDs and the transaction hash, or simulation result.
   */
  async createStreams(
    paramsArray: CreateStreamParams[],
    options?: WriteOptions
  ): Promise<
    { streamIds: string[]; txHash: string } | SimulateOnlyResult
  > {
    if (paramsArray.length === 0) throw new Error("At least one stream is required");
    for (const params of paramsArray) {
      if (params.amount <= 0n) throw new Error("Amount must be > 0");
      if (params.durationSeconds <= 0) throw new Error("Duration must be > 0");
    }

    const sender = await this.walletAdapter.getPublicKey();

    const operations = paramsArray.map((params) =>
      this.contract.call(
        "create_stream",
        nativeToScVal(sender, { type: "address" }),
        nativeToScVal(params.recipient, { type: "address" }),
        nativeToScVal(params.token, { type: "address" }),
        nativeToScVal(params.amount, { type: "i128" }),
        nativeToScVal(params.durationSeconds, { type: "u64" }),
        nativeToScVal(params.autoRenew, { type: "bool" })
      )
    );

    if (options?.simulateOnly) {
      const result = await this.simulateOp(operations[0]);
      return { simulated: true, result };
    }

    const before = await this.getStreamsBySender(sender);
    const txHash = await this.buildAndSubmit(operations);
    const after = await this.getStreamsBySender(sender);
    const streamIds = after.slice(before.length).map((s) => s.id);

    return { streamIds, txHash };
  }

  /**
   * Withdraws all currently claimable tokens from a stream.
   * @param params - Withdraw parameters.
   * @param options - Optional write options (e.g. simulateOnly).
   * @returns The transaction hash and withdrawn amount, or simulation result.
   */
  async withdraw(
    params: WithdrawParams,
    options?: WriteOptions
  ): Promise<
    { txHash: string; amount: string } | SimulateOnlyResult
  > {
    const recipient = await this.walletAdapter.getPublicKey();
    const claimable = await this.getClaimable(params.streamId);

    const operation = this.contract.call(
      "withdraw",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(recipient, { type: "address" })
    );

    if (options?.simulateOnly) {
      const result = await this.simulateOp(operation);
      return { simulated: true, result };
    }

    const txHash = await this.buildAndSubmit([operation]);
    return { txHash, amount: claimable.toString() };
  }

  /**
   * Cancels an active stream. Refunds unstreamed tokens to sender.
   * @param params - Cancel parameters.
   * @param options - Optional write options (e.g. simulateOnly).
   * @returns The transaction hash, or simulation result.
   */
  async cancelStream(
    params: CancelStreamParams,
    options?: WriteOptions
  ): Promise<
    { txHash: string } | SimulateOnlyResult
  > {
    const sender = await this.walletAdapter.getPublicKey();

    const operation = this.contract.call(
      "cancel_stream",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" })
    );

    if (options?.simulateOnly) {
      const result = await this.simulateOp(operation);
      return { simulated: true, result };
    }

    const txHash = await this.buildAndSubmit([operation]);
    return { txHash };
  }

  /**
   * Tops up an existing stream with additional tokens, extending its duration.
   * @param params - Top-up parameters.
   * @param options - Optional write options (e.g. simulateOnly).
   * @returns The transaction hash and new end time, or simulation result.
   */
  async topUp(
    params: TopUpParams,
    options?: WriteOptions
  ): Promise<
    { txHash: string; newEndTime: Date } | SimulateOnlyResult
  > {
    if (params.amount <= 0n) throw new Error("Amount must be > 0");
    const sender = await this.walletAdapter.getPublicKey();

    const operation = this.contract.call(
      "top_up",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(params.amount, { type: "i128" })
    );

    if (options?.simulateOnly) {
      const result = await this.simulateOp(operation);
      return { simulated: true, result };
    }

    const txHash = await this.buildAndSubmit([operation]);
    const stream = await this.getStream(params.streamId);
    return { txHash, newEndTime: new Date(stream.endTime * 1000) };
  }

  /**
   * Returns the full stream data for a given stream ID.
   * @param streamId - The stream ID to look up.
   */
  async getStream(streamId: string): Promise<Stream> {
    const publicKey = await this.walletAdapter.getPublicKey();
    const account = await this.withBreaker(() => this.server.getAccount(publicKey));
    const result = await this.withBreaker(() =>
      this.server.simulateTransaction(
        new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASES[this.network],
        })
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
    return scValToStream(returnVal);
  }

  /**
   * Returns the currently claimable amount in stroops for a stream.
   * @param streamId - The stream ID to check.
   */
  async getClaimable(streamId: string): Promise<bigint> {
    const publicKey = await this.walletAdapter.getPublicKey();
    const account = await this.withBreaker(() => this.server.getAccount(publicKey));
    const result = await this.withBreaker(() =>
      this.server.simulateTransaction(
        new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASES[this.network],
        })
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
    return BigInt(scValToNative(returnVal) as number);
  }

  /**
   * Returns all streams created by a sender address.
   * @param sender - The sender address to query.
   */
    async getStreamsBySender(sender: string): Promise<Stream[]> {
    const publicKey = await this.walletAdapter.getPublicKey();
    const account = await this.withBreaker(() => this.server.getAccount(publicKey));
    const result = await this.withBreaker(() =>
      this.server.simulateTransaction(
        new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASES[this.network],
        })
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
    return raw.map(scValToStream);
  }

  /**
   * Returns all streams targeting a recipient address.
   * @param recipient - The recipient address to query.
   */
  async getStreamsByRecipient(recipient: string): Promise<Stream[]> {
    const publicKey = await this.walletAdapter.getPublicKey();
    const account = await this.withBreaker(() => this.server.getAccount(publicKey));
    const result = await this.withBreaker(() =>
      this.server.simulateTransaction(
        new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASES[this.network],
        })
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
    return raw.map(scValToStream);
  }

  /**
   * Returns the underlying CircuitBreaker instance, if configured.
   */
  getCircuitBreaker(): CircuitBreaker | null {
    return this.breaker;
  }
}
