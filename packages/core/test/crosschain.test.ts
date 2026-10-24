import { describe, expect, it } from 'vitest';
import { collateralShortfalls, describeFlush, encodeFlushReport, keeperGateways, planFlush, releaseQueueReading, type VaultWatch } from '../src/crosschain';

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
  it('reads releaseQueue() outputs in order', () => {
    expect(releaseQueueReading([2n, 5n, 6n, 10n ** 15n, 4n])).toEqual({ pending: 2n, head: 5n, queued: 6n, pool: 10n ** 15n, nextFee: 4n });
  });
  it('logs one line per gateway, with why no report was written', () => {
    const flushing = q({ pending: 2n, queued: 2n });
    expect(describeFlush('arb', flushing, planFlush(flushing))).toMatch(/^arb gateway flush: 2 release\(s\) waiting .* -> flush up to 2 \(gas 750000\)$/);
    expect(describeFlush('arb', q({}), planFlush(q({})))).toMatch(/no report \(nothing to send\)$/);
    const short = q({ pending: 1n, pool: 1n });
    expect(describeFlush('arb', short, planFlush(short))).toMatch(/no report \(pool-short/);
    const noVault = q({ pending: 1n, nextFee: 0n });
    expect(describeFlush('arb', noVault, planFlush(noVault))).toMatch(/no report \(no-vault/);
  });
  it('the keeper config gets the gateway only for an auto-release (v2) gateway', () => {
    const names = { 'arbitrum-sepolia': 'ethereum-testnet-sepolia-arbitrum-1' };
    const home = { chain: 'arbitrum-sepolia', gateway: '0x4C393Ed28Cc1825CfBA5A4d6F2223589249C3a89' };
    expect(keeperGateways({ home: { ...home, version: 2 } }, names, { stateBlock: 'latest' })).toEqual([{
      chainSelectorName: 'ethereum-testnet-sepolia-arbitrum-1', gateway: home.gateway, maxItems: 10, baseGas: '250000', gasPerItem: '300000', stateBlock: 'latest',
    }]);
    expect(keeperGateways({ home }, names)).toEqual([]);
    expect(keeperGateways({ home: { ...home, version: 1 } }, names)).toEqual([]);
    expect(() => keeperGateways({ home: { ...home, chain: 'mars', version: 2 } }, names)).toThrow();
  });
});
