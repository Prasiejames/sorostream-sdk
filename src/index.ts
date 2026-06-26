export { SoroStreamClient } from "./SoroStreamClient.js";
export type { SoroStreamClientOptions } from "./SoroStreamClient.js";

// Wallet adapters are available at "@sorostream/sdk/wallets" to keep the core
// bundle free of browser-only @stellar/freighter-api code. The non-browser
// multisig and claim-delegate adapters are still re-exported here for convenience.
export { createMultisigAdapter, createClaimDelegateAdapter } from "./wallet.js";
export type { ClaimDelegateConfig } from "./wallet.js";

export { MockSoroStreamClient } from "./mock.js";
export { WebhookForwarder } from "./webhook.js";
export {
  toStroops,
  formatUSDC,
  calculateFlowRate,
  timeUntilStreamEnd,
  claimableNow,
  getPayoutSchedule,
} from "./utils.js";
export type { PayoutSchedulePoint } from "./utils.js";
export type {
  Stream,
  StreamStatus,
  CreateStreamParams,
  WithdrawParams,
  CancelStreamParams,
  TopUpParams,
  Network,
  WalletAdapter,
  MultisigSigner,
  StreamEvent,
  StreamEventType,
  StreamEventFilter,
  StreamSubscription,
  PaginationParams,
  PaginatedStreams,
  WebhookConfig,
} from "./types.js";
