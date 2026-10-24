import { describe, expect, it } from 'vitest';
import { collateralShortfalls, type VaultWatch } from '../src/crosschain';

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
