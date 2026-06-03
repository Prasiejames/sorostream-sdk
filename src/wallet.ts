import type { WalletAdapter, Network } from "./types.js";

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
