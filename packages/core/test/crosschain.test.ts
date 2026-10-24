import { describe, expect, it } from 'vitest';
import { collateralShortfalls, encodeFlushReport, planFlush, type VaultWatch } from '../src/crosschain';

const watch: VaultWatch = { homeChain: 'ethereum-testnet-sepolia-arbitrum-1', receipt: '0xr', assetChain: 'robinhood-testnet', vault: '0xv', token: '0xt', label: 'TSLA on Robinhood' };
const reading = (o: Partial<{ locked: bigint; unclaimedTotal: bigint; vaultBalance: bigint; receiptsOutstanding: bigint }>) =>
  ({ watch, locked: 100n, unclaimedTotal: 0n, vaultBalance: 100n, receiptsOutstanding: 100n, ...o });

describe('cross-chain collateral checks', () => {
  it('a fully backed vault has no shortfall', () => {
    expect(collateralShortfalls([reading({})])).toEqual([]);
  });
  it('messages in flight never look like a shortfall', () => {
    // A lock not yet credited at home; a redemption burned at home, not yet paid on the asset chain.
    expect(collateralShortfalls([reading({ receiptsOutstanding: 60n })])).toEqual([]);
  });
  it('unclaimed releases are owed but no longer locked', () => {
    expect(collateralShortfalls([reading({ locked: 60n, unclaimedTotal: 40n, vaultBalance: 100n, receiptsOutstanding: 60n })])).toEqual([]);
  });
  it('the token taking tokens back from the vault is a shortfall', () => {
    expect(collateralShortfalls([reading({ vaultBalance: 70n })])).toEqual([{ watch, kind: 'vault-backing', missing: 30n }]);
  });
  it('receipts the vault does not account for are a shortfall', () => {
    expect(collateralShortfalls([reading({ receiptsOutstanding: 120n })])).toEqual([{ watch, kind: 'receipts-exceed-locked', missing: 20n }]);
  });
});

describe('auto-release queue (HomeGateway v2)', () => {
  const q = (o: Partial<{ pending: bigint; head: bigint; queued: bigint; pool: bigint; nextFee: bigint }>) =>
    ({ pending: 0n, head: 1n, queued: 0n, pool: 10n ** 16n, nextFee: 5n * 10n ** 13n, ...o });
  it('nothing queued: no report', () => {
    expect(planFlush(q({}))).toMatchObject({ flush: false, reason: 'empty' });
  });
  it('flushes what is pending, within the cap and what the pool pays for', () => {
    expect(planFlush(q({ pending: 3n, queued: 3n }))).toEqual({ flush: true, maxItems: 3, gasLimit: 150_000n + 3n * 300_000n });
    expect(planFlush(q({ pending: 40n }), { maxItems: 50 }).maxItems).toBe(25);
    expect(planFlush(q({ pending: 40n, pool: 2n * 5n * 10n ** 13n })).maxItems).toBe(2);
  });
  it('an empty pool or a chain without a vault waits (the releases stay queued)', () => {
    expect(planFlush(q({ pending: 2n, pool: 1n }))).toMatchObject({ flush: false, reason: 'pool-short' });
    expect(planFlush(q({ pending: 2n, nextFee: 0n }))).toMatchObject({ flush: false, reason: 'no-vault' });
  });
  it('the report is abi.encode(uint8 1, uint256 maxItems)', () => {
    expect(encodeFlushReport(7)).toBe(`0x${'0'.repeat(63)}1${'0'.repeat(63)}7`);
    expect(() => encodeFlushReport(0)).toThrow();
  });
});
