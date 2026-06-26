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
  RenewalForecast,
  Stream,
  TopUpParams,
  WalletAdapter,
  WithdrawParams,
} from "./types.js";

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
  /**
   * One or more RPC URLs for the Stellar Soroban RPC endpoint.
   * If multiple URLs are provided, the client will failover to the next
   * URL on connection failure. Defaults to the network's default RPC.
   */
  rpcUrl?: string | string[];
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
  private readonly rpcUrls: string[];
  private readonly contract: Contract;
  private readonly network: Network;
  private readonly walletAdapter: WalletAdapter;

  constructor(options: SoroStreamClientOptions) {
    this.network = options.network;
    this.walletAdapter = options.walletAdapter;
    this.contract = new Contract(options.contractId);
    this.rpcUrls = options.rpcUrl
      ? (Array.isArray(options.rpcUrl) ? options.rpcUrl : [options.rpcUrl])
      : [RPC_URLS[options.network]];
  }

  /**
   * Executes an RPC call with failover across all configured RPC URLs.
   * On connection failure, the next URL in the list is tried automatically.
   */
  private async withServer<T>(
    fn: (server: rpc.Server) => Promise<T>
  ): Promise<T> {
    let lastError: unknown;
    for (const url of this.rpcUrls) {
      const server = new rpc.Server(url, { allowHttp: false });
      try {
        return await fn(server);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  private async buildAndSubmit(operation: xdr.Operation): Promise<string> {
    return this.withServer(async (server) => {
      const publicKey = await this.walletAdapter.getPublicKey();
      const account = await server.getAccount(publicKey);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASES[this.network],
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const preparedTx = await server.prepareTransaction(tx);
      const signedXdr = await this.walletAdapter.signTransaction(
        preparedTx.toXDR(),
        this.network
      );

      const result = await server.sendTransaction(
        TransactionBuilder.fromXDR(
          signedXdr,
          NETWORK_PASSPHRASES[this.network]
        )
      );

      if (result.status === "ERROR") {
        throw new Error(
          `Transaction failed: ${JSON.stringify(result.errorResult)}`
        );
      }

      let response = await server.getTransaction(result.hash);
      while (response.status === "NOT_FOUND") {
        await new Promise((r) => setTimeout(r, 1000));
        response = await server.getTransaction(result.hash);
      }

      if (response.status === "FAILED") {
        throw new Error(`Transaction failed: ${result.hash}`);
      }

      return result.hash;
    });
  }

  /**
   * Creates a new payment stream.
   * @param params - Stream creation parameters.
   * @returns The new stream ID and transaction hash.
   */
  async createStream(
    params: CreateStreamParams
  ): Promise<{ streamId: string; txHash: string }> {
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

    const streams = await this.getStreamsBySender(sender);
    const latest = streams[streams.length - 1];
    if (!latest) throw new Error("Stream not found after creation");

    return { streamId: latest.id, txHash };
  }

  /**
   * Withdraws all currently claimable tokens from a stream.
   * @param params - Withdraw parameters.
   * @returns The transaction hash and withdrawn amount.
   */
  async withdraw(
    params: WithdrawParams
  ): Promise<{ txHash: string; amount: string }> {
    const recipient = await this.walletAdapter.getPublicKey();
    const claimable = await this.getClaimable(params.streamId);

    const operation = this.contract.call(
      "withdraw",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(recipient, { type: "address" })
    );

    const txHash = await this.buildAndSubmit(operation);
    return { txHash, amount: claimable.toString() };
  }

  /**
   * Cancels an active stream. Refunds unstreamed tokens to sender.
   * @param params - Cancel parameters.
   * @returns The transaction hash.
   */
  async cancelStream(params: CancelStreamParams): Promise<{ txHash: string }> {
    const sender = await this.walletAdapter.getPublicKey();

    const operation = this.contract.call(
      "cancel_stream",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" })
    );

    const txHash = await this.buildAndSubmit(operation);
    return { txHash };
  }

  /**
   * Tops up an existing stream with additional tokens, extending its duration.
   * @param params - Top-up parameters.
   * @returns The transaction hash and new end time.
   */
  async topUp(
    params: TopUpParams
  ): Promise<{ txHash: string; newEndTime: Date }> {
    if (params.amount <= 0n) throw new Error("Amount must be > 0");
    const sender = await this.walletAdapter.getPublicKey();

    const operation = this.contract.call(
      "top_up",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(params.amount, { type: "i128" })
    );

    const txHash = await this.buildAndSubmit(operation);
    const stream = await this.getStream(params.streamId);
    return { txHash, newEndTime: new Date(stream.endTime * 1000) };
  }

  /**
   * Returns the full stream data for a given stream ID.
   * @param streamId - The stream ID to look up.
   */
  async getStream(streamId: string): Promise<Stream> {
    return this.withServer(async (server) => {
      const result = await server.simulateTransaction(
        new TransactionBuilder(
          await server.getAccount(await this.walletAdapter.getPublicKey()),
          {
            fee: BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASES[this.network],
          }
        )
          .addOperation(
            this.contract.call(
              "get_stream",
              nativeToScVal(BigInt(streamId), { type: "u64" })
            )
          )
          .setTimeout(30)
          .build()
      );

      if (rpc.Api.isSimulationError(result)) {
        throw new Error(`Stream not found: ${streamId}`);
      }

      const returnVal = (
        result as rpc.Api.SimulateTransactionSuccessResponse
      ).result?.retval;
      if (!returnVal) throw new Error("No return value from contract");
      return scValToStream(returnVal);
    });
  }

  /**
   * Returns the currently claimable amount in stroops for a stream.
   * @param streamId - The stream ID to check.
   */
  async getClaimable(streamId: string): Promise<bigint> {
    return this.withServer(async (server) => {
      const result = await server.simulateTransaction(
        new TransactionBuilder(
          await server.getAccount(await this.walletAdapter.getPublicKey()),
          {
            fee: BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASES[this.network],
          }
        )
          .addOperation(
            this.contract.call(
              "get_claimable",
              nativeToScVal(BigInt(streamId), { type: "u64" })
            )
          )
          .setTimeout(30)
          .build()
      );

      if (rpc.Api.isSimulationError(result)) return 0n;

      const returnVal = (
        result as rpc.Api.SimulateTransactionSuccessResponse
      ).result?.retval;
      if (!returnVal) return 0n;
      return BigInt(scValToNative(returnVal) as number);
    });
  }

  /**
   * Returns all streams created by a sender address.
   * @param sender - The sender address to query.
   */
  async getStreamsBySender(sender: string): Promise<Stream[]> {
    return this.withServer(async (server) => {
      const result = await server.simulateTransaction(
        new TransactionBuilder(
          await server.getAccount(await this.walletAdapter.getPublicKey()),
          {
            fee: BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASES[this.network],
          }
        )
          .addOperation(
            this.contract.call(
              "get_streams_by_sender",
              nativeToScVal(sender, { type: "address" })
            )
          )
          .setTimeout(30)
          .build()
      );

      if (rpc.Api.isSimulationError(result)) return [];

      const returnVal = (
        result as rpc.Api.SimulateTransactionSuccessResponse
      ).result?.retval;
      if (!returnVal) return [];

      const raw = scValToNative(returnVal) as xdr.ScVal[];
      return raw.map(scValToStream);
    });
  }

  /**
   * Returns all streams targeting a recipient address.
   * @param recipient - The recipient address to query.
   */
  async getStreamsByRecipient(recipient: string): Promise<Stream[]> {
    return this.withServer(async (server) => {
      const result = await server.simulateTransaction(
        new TransactionBuilder(
          await server.getAccount(await this.walletAdapter.getPublicKey()),
          {
            fee: BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASES[this.network],
          }
        )
          .addOperation(
            this.contract.call(
              "get_streams_by_recipient",
              nativeToScVal(recipient, { type: "address" })
            )
          )
          .setTimeout(30)
          .build()
      );

      if (rpc.Api.isSimulationError(result)) return [];

      const returnVal = (
        result as rpc.Api.SimulateTransactionSuccessResponse
      ).result?.retval;
      if (!returnVal) return [];

      const raw = scValToNative(returnVal) as xdr.ScVal[];
      return raw.map(scValToStream);
    });
  }

  /**
   * Computes the renewal forecast for an auto-renewing stream.
   *
   * Streams created with `autoRenew: true` silently restart on-chain when
   * `withdraw` is called after `endTime` — the contract re-pulls the deposit
   * and resets `startTime`/`endTime`. This method computes the next renewal
   * date and amount from the current stream state so UIs can display
   * "renews on X for Y USDC".
   *
   * @param streamId - The stream ID to forecast.
   * @returns A `RenewalForecast` if the stream has `autoRenew` enabled and is
   *   not cancelled, otherwise `null`.
   */
  async getRenewalForecast(streamId: string): Promise<RenewalForecast | null> {
    const stream = await this.getStream(streamId);

    if (!stream.autoRenew) return null;
    if (stream.status === "Cancelled") return null;

    const now = Math.floor(Date.now() / 1000);
    const duration = stream.endTime - stream.startTime;

    if (now < stream.endTime) {
      // Still within the current period — renews at endTime
      const nextStart = stream.endTime;
      return {
        nextRenewalDate: new Date(nextStart * 1000),
        amount: stream.deposit,
        nextEndTime: new Date((nextStart + duration) * 1000),
      };
    }

    // Past end time — renewal would happen on next withdraw
    const nextStart = now;
    return {
      nextRenewalDate: new Date(nextStart * 1000),
      amount: stream.deposit,
      nextEndTime: new Date((nextStart + duration) * 1000),
    };
  }
}
