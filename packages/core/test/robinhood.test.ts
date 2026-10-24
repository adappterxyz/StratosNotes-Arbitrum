import { describe, expect, it } from 'vitest';
import {
  CASH_TOKENS, collateralTokenOf, compileTemplate, deliverableToken, EXAMPLE_PRODUCTS, EXTERNAL_TOKENS, FEEDS, instantiateProduct,
  ROBINHOOD_STOCK_TOKENS, SEED_TEMPLATES, validateProductParams, type ProductParams,
} from '../src';

const rc: ProductParams = {
  ...EXAMPLE_PRODUCTS['reverse-convertible'], name: 'RC on TSLA', underlyings: [FEEDS.TSLA], settlement: 'physical',
};

describe("Robinhood Chain's own stock tokens", () => {
  it('delivers and pledges Robinhood TSLA (18 decimals) when the note chooses them, test tokens otherwise', () => {
    expect(deliverableToken({ stockTokens: 'robinhood' }, 'TSLA')).toEqual({ token: 'TSLA', decimals: 18 });
    expect(deliverableToken({}, 'TSLA')).toEqual({ token: 'tTSLA', decimals: 9 });
    expect(collateralTokenOf({ stockTokens: 'robinhood' }, 'AMZN')).toEqual({ token: 'AMZN', decimals: 18 });
    expect(collateralTokenOf({}, 'AMZN')).toBeUndefined();
    // Stocks Robinhood does not publish fall back to the test tokens, which are deployed on Robinhood Chain too.
    expect(deliverableToken({ stockTokens: 'robinhood' }, 'NVDA')).toEqual({ token: 'tNVDA', decimals: 9 });
    expect(collateralTokenOf({ stockTokens: 'robinhood' }, 'USD')).toEqual({ token: 'USDG', decimals: 6 });
  });

  it('compiles the token choice into the definition: real TSLA is an 18-decimal asset', () => {
    const real = instantiateProduct({ ...rc, stockTokens: 'robinhood' });
    const test = instantiateProduct(rc);
    expect(real.assets.find(a => a.id === 'd_TSLA')).toMatchObject({ token: 'TSLA', decimals: 18 });
    expect(test.assets.find(a => a.id === 'd_TSLA')).toMatchObject({ token: 'tTSLA', decimals: 9 });
    expect(compileTemplate({ product: { ...rc, stockTokens: 'robinhood' } }).hash).not.toEqual(compileTemplate({ product: rc }).hash);
  });

  it('refuses AMZN collateral without Robinhood tokens, and an unknown token set', () => {
    const amzn: ProductParams = { ...EXAMPLE_PRODUCTS.phoenix, collateral: [{ symbol: 'AMZN', haircutPct: 60 }] };
    expect(validateProductParams(amzn).join(' ')).toMatch(/no AMZN token/);
    expect(validateProductParams({ ...amzn, stockTokens: 'robinhood' })).toEqual([]);
    expect(validateProductParams({ ...amzn, stockTokens: 'nasdaq' as never }).join(' ')).toMatch(/Stock tokens/);
  });

  it('maps every Robinhood stock token to its testnet address', () => {
    const addrs = EXTERNAL_TOKENS['robinhood-testnet'];
    for (const sym of Object.keys(ROBINHOOD_STOCK_TOKENS)) expect(addrs[ROBINHOOD_STOCK_TOKENS[sym].token]).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('settles in USDG on both testnets', () => {
    expect(instantiateProduct(rc).assets.find(a => a.id === 'cash')).toMatchObject({ token: 'USDG', decimals: 6 });
    for (const chain of ['arbitrum-sepolia', 'robinhood-testnet']) expect(CASH_TOKENS[chain]).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('prices AMZN from Chainlink on Arbitrum One with the equity staleness allowance', () => {
    expect(FEEDS.AMZN).toMatchObject({ feedChain: 'ethereum-mainnet-arbitrum-1', staleness: 345_600 });
  });

  it('ships the two Robinhood Chain templates, valid and compiled', () => {
    const rh = SEED_TEMPLATES.filter(t => t.source.product?.stockTokens === 'robinhood');
    expect(rh.map(t => t.name)).toEqual(['12M Worst-of Phoenix on TSLA, AMZN', '12M Reverse Convertible on TSLA, physical']);
    for (const t of rh) {
      expect(validateProductParams(t.source.product!)).toEqual([]);
      expect(compileTemplate(t.source).hash.length).toBe(32);
    }
  });
});
