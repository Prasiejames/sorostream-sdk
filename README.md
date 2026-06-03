# @sorostream/sdk

![npm](https://img.shields.io/npm/v/@sorostream/sdk)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![License](https://img.shields.io/badge/license-MIT-green)
![CI](https://github.com/SoroStream/sorostream-sdk/actions/workflows/test.yml/badge.svg)

TypeScript SDK for the **SoroStream** payment streaming protocol on Stellar Soroban. Stream USDC by the second for salaries, subscriptions, vesting schedules, and grant disbursements.

## Installation

```bash
npm install @sorostream/sdk
```

## Quick Start

```typescript
import { SoroStreamClient, createFreighterAdapter, toStroops } from "@sorostream/sdk";

// 1. Connect wallet
const walletAdapter = await createFreighterAdapter();

// 2. Create client
const client = new SoroStreamClient({
  network: "testnet",
  contractId: "YOUR_CONTRACT_ID",
  walletAdapter,
});

// 3. Create a stream: 100 USDC over 30 days
const { streamId, txHash } = await client.createStream({
  recipient: "GRECIPIENT_ADDRESS",
  token: "GUSDC_TOKEN_ADDRESS",
  amount: toStroops("100"),
  durationSeconds: 30 * 24 * 60 * 60,
  autoRenew: false,
});

// 4. Check claimable balance
const claimable = await client.getClaimable(streamId);

// 5. Withdraw
await client.withdraw({ streamId });
```

## API Reference

### `SoroStreamClient`

| Method | Description |
|--------|-------------|
| `createStream(params)` | Creates a new payment stream. Returns `{ streamId, txHash }` |
| `withdraw(params)` | Withdraws all claimable tokens. Returns `{ txHash, amount }` |
| `cancelStream(params)` | Cancels stream, refunds sender remainder. Returns `{ txHash }` |
| `topUp(params)` | Adds tokens, extends duration. Returns `{ txHash, newEndTime }` |
| `getStream(streamId)` | Returns full `Stream` object |
| `getClaimable(streamId)` | Returns claimable amount in stroops |
| `getStreamsBySender(sender)` | Returns all streams for a sender |
| `getStreamsByRecipient(recipient)` | Returns all streams for a recipient |

### Utilities

| Function | Description |
|----------|-------------|
| `toStroops(usdc)` | Converts USDC decimal string to stroops bigint |
| `formatUSDC(stroops)` | Formats stroops bigint to USDC string |
| `calculateFlowRate(amount, duration)` | Returns stroops/second flow rate |
| `claimableNow(stream)` | Estimates current claimable (client-side) |
| `timeUntilStreamEnd(stream)` | Returns seconds until stream ends |

### Wallet

| Function | Description |
|----------|-------------|
| `createFreighterAdapter()` | Creates a WalletAdapter backed by Freighter extension |
| `connectWallet()` | Prompts Freighter connection, returns public key |

## Local Setup

```bash
npm install
npm test        # run unit tests
npm run lint    # type check
npm run build   # build to dist/
```

## Contributing via Drips Wave

This project participates in the **Stellar Wave Program** on [Drips Wave](https://drips.network/wave). Contributors earn rewards for resolving issues during weekly Wave sprints.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow.

## Open Issues

### Issue #1 — [Trivial] Add JSDoc comments to all SoroStreamClient public methods

**Description:** Several public methods in `SoroStreamClient.ts` are missing or have incomplete JSDoc comments. Add full `@param`, `@returns`, and `@throws` documentation to every public method.

**Acceptance Criteria:**
- [ ] All public methods have complete JSDoc
- [ ] `npm run lint` passes
- [ ] PR references this issue

**Complexity:** `trivial` | `good first issue`

---

### Issue #2 — [Trivial] Add input validation — reject createStream if amount <= 0 or durationSeconds <= 0

**Description:** `createStream()` already validates `amount` and `durationSeconds`, but the error messages could be more descriptive. Update to include the invalid value in the message (e.g. `"Amount must be > 0, got 0"`), and add unit tests covering both validation paths.

**Acceptance Criteria:**
- [ ] Error messages include the invalid value
- [ ] Unit tests for both `amount <= 0` and `durationSeconds <= 0` paths
- [ ] `npm test` passes

**Complexity:** `trivial` | `good first issue`

---

### Issue #3 — [Trivial] Export claimableNow() utility and add unit tests for its calculation

**Description:** `claimableNow()` is exported but lacks edge-case tests. Add tests for: stream at exactly `lastWithdrawTime` (expects 0), stream past `endTime` (expects capped value), and zero `flowRate` stream.

**Acceptance Criteria:**
- [ ] Three new unit tests added to `test/client.test.ts`
- [ ] All tests pass with `npm test`

**Complexity:** `trivial` | `good first issue`

---

### Issue #4 — [Medium] Add TypeScript event listener: onStreamWithdrawn(streamId, callback)

**Description:** Add a polling-based event listener method to `SoroStreamClient`:
```ts
onStreamWithdrawn(streamId: string, callback: (amount: bigint) => void, intervalMs?: number): () => void
```
It should poll `getClaimable()` every `intervalMs` (default 5000) and call `callback` when the value changes. Returns a cleanup function to stop polling.

**Acceptance Criteria:**
- [ ] Method implemented with correct TypeScript types
- [ ] Returns a stop function
- [ ] Unit test using `vi.useFakeTimers()`
- [ ] `npm test` and `npm run lint` pass

**Complexity:** `medium`

---

### Issue #5 — [Medium] Build getStreamHistory() — fetches all past streams including cancelled ones

**Description:** Implement `getStreamHistory(address: string): Promise<Stream[]>` that returns all streams for an address including `Cancelled` and `Completed` ones. Should call both `getStreamsBySender` and `getStreamsByRecipient`, deduplicate by `id`, and sort by `startTime` descending.

**Acceptance Criteria:**
- [ ] `getStreamHistory()` implemented on `SoroStreamClient`
- [ ] Deduplicates streams appearing in both sender and recipient results
- [ ] Sorted by `startTime` descending
- [ ] Unit tests with mocked responses
- [ ] `npm test` passes

**Complexity:** `medium`

---

### Issue #6 — [High] Add WalletConnect adapter alongside Freighter for mobile wallet support

**Description:** Implement a `createWalletConnectAdapter(projectId: string): Promise<WalletAdapter>` that wraps the WalletConnect v2 SDK to enable mobile wallet support. The adapter must implement the same `WalletAdapter` interface as the Freighter adapter.

**Acceptance Criteria:**
- [ ] `createWalletConnectAdapter(projectId)` exported from `src/index.ts`
- [ ] Implements `WalletAdapter` interface fully
- [ ] Works on testnet and mainnet
- [ ] Unit tests with mocked WalletConnect client
- [ ] `npm test` and `npm run lint` pass

**Complexity:** `high`

---

### Issue #7 — [High] Implement real-time claimable balance polling with RxJS Observable output

**Description:** Add a `watchClaimable(streamId: string, intervalMs?: number): Observable<bigint>` method that uses RxJS to emit the current claimable balance on a configurable interval. Should complete when the stream is no longer Active.

**Acceptance Criteria:**
- [ ] `rxjs` added as a peer dependency
- [ ] `watchClaimable()` returns an `Observable<bigint>`
- [ ] Observable completes when `stream.status !== "Active"`
- [ ] Unit tests using `TestScheduler` from rxjs/testing
- [ ] `npm test` and `npm run lint` pass

**Complexity:** `high`
