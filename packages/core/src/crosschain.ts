/**
 * Cross-chain collateral (stage 1): a note runs on its home chain (Arbitrum) while collateral stays locked in a
 * RemoteVault on another chain (Robinhood Chain first). The home side holds RemoteReceipts, which the engine
 * treats as ordinary collateral. The keeper (CRE) checks every run that each vault still backs its receipts:
 *
 *   vault backing   = token.balanceOf(vault) - unclaimedTotal(token)   (what the vault can still pay)
 *   vault liability = locked(token)                                     (receipts outstanding + releases in flight)
 *   receipts        = receipt.totalSupply() at home
 *
 * In-flight messages only ever make `locked` exceed `receipts` (a lock not yet credited at home, a redemption
 * burned at home not yet paid on the asset chain, or an auto-release burned at home and still queued at the
 * gateway), never the reverse, so:
 *   - backing < locked     -> the token took tokens back from the vault (paused, frozen, clawed back);
 *   - receipts > locked    -> receipts exist that the vault does not account for (must never happen).
 * Both are reported as shortfalls; the first one also makes the note's coverage overstated, so the app and the
 * keeper surface it next to the note's margin.
 */
export interface VaultWatch {
  /** Home chain (CRE chain-selector name) and its receipt contract. */
  homeChain: string;
  receipt: string;
  /** Asset chain (CRE chain-selector name), the vault there and the locked token. */
  assetChain: string;
  vault: string;
  token: string;
  /** Label for logs, e.g. "TSLA on Robinhood". */
  label?: string;
}

export interface VaultReading {
  watch: VaultWatch;
  locked: bigint;
  unclaimedTotal: bigint;
  vaultBalance: bigint;
  receiptsOutstanding: bigint;
}

export type ShortfallKind = 'vault-backing' | 'receipts-exceed-locked';

export interface Shortfall {
  watch: VaultWatch;
  kind: ShortfallKind;
  /** Base units of the token missing. */
  missing: bigint;
}

export function collateralShortfalls(readings: VaultReading[]): Shortfall[] {
  const out: Shortfall[] = [];
  for (const r of readings) {
    const backing = r.vaultBalance - r.unclaimedTotal;
    if (backing < r.locked) out.push({ watch: r.watch, kind: 'vault-backing', missing: r.locked - backing });
    if (r.receiptsOutstanding > r.locked) out.push({ watch: r.watch, kind: 'receipts-exceed-locked', missing: r.receiptsOutstanding - r.locked });
  }
  return out;
}

/** The ABI fragments the keeper reads (RemoteVault on the asset chain, RemoteReceipt at home). */
export const remoteVaultAbi = [
  { type: 'function', name: 'locked', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'unclaimedTotal', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export const erc20ReadAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

// ---- Auto-release (HomeGateway v2): the queue the keeper flushes ----------------------------------------------

/**
 * Receipts leaving the engine (payouts after a default, the issuer's collateral at maturity, any withdraw or push)
 * are burned and queued at the HomeGateway as RELEASEs to the same address on the asset chain. Anyone may flush the
 * queue (fees from the gateway's ETH pool); the CRE keeper does it with a report. Its per-run read and write:
 *
 *   read   HomeGateway.releaseQueue() -> (pending, head, queued, pool, nextFee)        one call, home chain
 *   write  report abi.encode(uint8 kind = 1, uint256 maxItems) to the gateway           receiver = the gateway
 *          (onReport through the KeystoneForwarder; the gateway checks the forwarder like the engine does)
 *
 * The report never reverts on an empty queue, an empty pool or a pause; it sends at most 25 releases.
 */
export const releaseQueueAbi = [
  {
    type: 'function', name: 'releaseQueue', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'pending', type: 'uint256' }, { name: 'head', type: 'uint256' }, { name: 'queued', type: 'uint256' },
      { name: 'pool', type: 'uint256' }, { name: 'nextFee', type: 'uint256' },
    ],
  },
] as const;

/** Report kind: flush queued releases. */
export const REPORT_FLUSH = 1;
/** The gateway sends at most this many per flush. */
export const MAX_FLUSH = 25;

export interface ReleaseQueueReading { pending: bigint; head: bigint; queued: bigint; pool: bigint; nextFee: bigint }

export interface FlushPlan {
  flush: boolean;
  /** Releases to ask for in the report. */
  maxItems: number;
  /** Gas for the report's transaction (base + per release). */
  gasLimit: bigint;
  /** Why not, when flush is false (for logs). */
  reason?: 'empty' | 'pool-short' | 'no-vault';
}

/**
 * Whether the keeper should write a flush report this run, and how big. `nextFee` is the fee of the oldest release
 * waiting; 0 with something pending means its chain has no vault configured (an operator issue: logged, no write).
 * Gas: about 60k of report overhead plus one CCIP send per release (~200k on Arbitrum Sepolia's router, with margin).
 */
export function planFlush(q: ReleaseQueueReading, opts: { maxItems?: number; baseGas?: bigint; gasPerItem?: bigint } = {}): FlushPlan {
  const cap = Math.max(1, Math.min(opts.maxItems ?? 10, MAX_FLUSH));
  const base = opts.baseGas ?? 150_000n;
  const per = opts.gasPerItem ?? 300_000n;
  if (q.pending === 0n) return { flush: false, maxItems: 0, gasLimit: 0n, reason: 'empty' };
  if (q.nextFee === 0n) return { flush: false, maxItems: 0, gasLimit: 0n, reason: 'no-vault' };
  if (q.pool < q.nextFee) return { flush: false, maxItems: 0, gasLimit: 0n, reason: 'pool-short' };
  // Fees are close to equal per message: send what the pool can pay for, within the cap.
  const affordable = q.pool / q.nextFee;
  const n = Number([q.pending, affordable, BigInt(cap)].reduce((a, b) => (a < b ? a : b)));
  return { flush: true, maxItems: n, gasLimit: base + per * BigInt(n) };
}

const word = (v: bigint) => BigInt.asUintN(256, v).toString(16).padStart(64, '0');

/** The flush report: abi.encode(uint8 kind = REPORT_FLUSH, uint256 maxItems), as 0x-hex (64 bytes). */
export function encodeFlushReport(maxItems: number): `0x${string}` {
  if (!Number.isInteger(maxItems) || maxItems < 1) throw new Error('maxItems must be a positive integer');
  return `0x${word(BigInt(REPORT_FLUSH))}${word(BigInt(maxItems))}`;
}

/** The gateway's queue events (for the app and indexers): a release queued for `account`, and its CCIP send. */
export const releaseEventsAbi = [
  {
    type: 'event', name: 'ReleaseQueued', anonymous: false,
    inputs: [
      { name: 'index', type: 'uint256', indexed: true }, { name: 'releaseId', type: 'bytes32', indexed: true },
      { name: 'account', type: 'address', indexed: true }, { name: 'receipt', type: 'address', indexed: false },
      { name: 'to', type: 'address', indexed: false }, { name: 'added', type: 'uint256', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'ReleaseSent', anonymous: false,
    inputs: [
      { name: 'index', type: 'uint256', indexed: true }, { name: 'releaseId', type: 'bytes32', indexed: true },
      { name: 'to', type: 'address', indexed: true }, { name: 'receipt', type: 'address', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false }, { name: 'messageId', type: 'bytes32', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false }, { name: 'fromPool', type: 'bool', indexed: false },
    ],
  },
] as const;
