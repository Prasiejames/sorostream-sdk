import type { WalletAdapter, Network } from "./types.js";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: "Public Global Stellar Network ; September 2015",
  testnet: "Test SDF Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
};

/**
 * Creates a WalletAdapter backed by the Freighter browser extension.
 * Dynamically imports @stellar/freighter-api to avoid SSR issues.
 */
export async function createFreighterAdapter(): Promise<WalletAdapter> {
  const freighter = await import("@stellar/freighter-api");

  return {
    async isConnected(): Promise<boolean> {
      const result = await freighter.isConnected();
      return result.isConnected;
    },

    async getPublicKey(): Promise<string> {
      const result = await freighter.getAddress();
      if (result.error) throw new Error(result.error.message);
      return result.address;
    },

    async signTransaction(xdr: string, network: Network): Promise<string> {
      const result = await freighter.signTransaction(xdr, {
        networkPassphrase: NETWORK_PASSPHRASES[network],
      });
      if (result.error) throw new Error(result.error.message);
      return result.signedTxXdr;
    },
  };
}

/**
 * Creates a server-side WalletAdapter that signs directly with a Stellar Keypair.
 * Suitable for Node.js scripts, backends, and automated payouts.
 *
 * @param secretKey - The Stellar secret key (base-32 encoded seed starting with "S").
 *
 * @example
 * ```ts
 * const adapter = createKeypairAdapter("SAZ...YOUR...SECRET...KEY...");
 * const client = new SoroStreamClient({ network: "testnet", contractId: "...", walletAdapter: adapter });
 * ```
 */
export function createKeypairAdapter(secretKey: string): WalletAdapter {
  const keypair = Keypair.fromSecret(secretKey);

  return {
    async isConnected(): Promise<boolean> {
      return true;
    },

    async getPublicKey(): Promise<string> {
      return keypair.publicKey();
    },

    async signTransaction(xdr: string, network: Network): Promise<string> {
      const tx = TransactionBuilder.fromXDR(
        xdr,
        NETWORK_PASSPHRASES[network]
      );
      tx.sign(keypair);
      return tx.toEnvelope().toXDR("base64");
    },
  };
}

/**
 * Prompts the user to connect their Freighter wallet.
 * Throws if Freighter is not installed or the user rejects.
 */
export async function connectWallet(): Promise<string> {
  const freighter = await import("@stellar/freighter-api");
  const connected = await freighter.isConnected();
  if (!connected.isConnected) {
    throw new Error("Freighter extension is not installed");
  }
  const result = await freighter.getAddress();
  if (result.error) throw new Error(result.error.message);
  return result.address;
}
