import { describe, expect, it } from 'vitest';
import {
  CASH_TOKENS, CHAIN_TOKENS, collateralChoices, collateralSymbolOfAsset, collateralTokenOf, compileTemplate, deliverableToken, EXAMPLE_PRODUCTS,
  EXAMPLE_WORST_OF, EXTERNAL_TOKENS, FEEDS, instantiateProduct, isRetiredTestToken, normalizeParams, NOTE_CHAINS, RETIRED_TEST_TOKENS,
  SEED_TEMPLATES, templateOffered, UNPRICED_STOCKS, validateProductParams, type ProductParams,
} from '../src';

const rc: ProductParams = {
  ...EXAMPLE_PRODUCTS['reverse-convertible'], name: 'RC on TSLA', underlyings: [FEEDS.TSLA], settlement: 'physical',
};
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const tokensOf = (p: ProductParams) => instantiateProduct(p).assets.filter(a => a.kind === 'cash').map(a => a.token!);

describe('real tokens per chain', () => {
  it('lists USDG and WETH on Arbitrum Sepolia; USDG, WETH and the stock tokens on Robinhood Chain', () => {
    expect(Object.keys(CHAIN_TOKENS['arbitrum-sepolia']).sort()).toEqual(['USDG', 'WETH']);
    expect(Object.keys(CHAIN_TOKENS['robinhood-testnet']).sort()).toEqual(['AMD', 'AMZN', 'NFLX', 'PLTR', 'TSLA', 'USDG', 'WETH']);
    for (const c of NOTE_CHAINS) for (const t of Object.values(CHAIN_TOKENS[c])) {
      expect(t.address).toMatch(ADDR);
      expect(EXTERNAL_TOKENS[c][t.token]).toBe(t.address);
      expect(isRetiredTestToken(t.token)).toBe(false);
    }
    expect(CHAIN_TOKENS['arbitrum-sepolia'].WETH.address).toBe('0x980B62Da83eFf3D4576C647993b0c1D7faf17c73');
    expect(CHAIN_TOKENS['robinhood-testnet'].WETH.address).toBe('0x7943e237c7F95DA44E0301572D358911207852Fa');
    expect(CASH_TOKENS['arbitrum-sepolia']).toBe('0xFFC95faa3d63Cde504a05B567C600B78C0b41892');
    expect(CASH_TOKENS['robinhood-testnet']).toBe('0x7E955252E15c84f5768B83c41a71F9eba181802F');
    expect(UNPRICED_STOCKS).toEqual(['NFLX']);
  });

  it('delivers the real token of the note\'s chain', () => {
    // Arbitrum (the default): WETH; BTC is synthetic and stocks are not carried over, so they settle in cash there.
    expect(deliverableToken({}, 'ETH')).toEqual({ token: 'WETH', decimals: 18 });
    expect(deliverableToken({}, 'BTC')).toBeUndefined();
    expect(deliverableToken({}, 'TSLA')).toBeUndefined();
    expect(deliverableToken({ chain: 'arbitrum-sepolia' }, 'AMZN')).toBeUndefined();
    // Robinhood Chain: its own stock tokens and WETH; no wrapped BTC there.
    const rh = { chain: 'robinhood-testnet' as const };
    expect(deliverableToken(rh, 'TSLA')).toEqual({ token: 'TSLA', decimals: 18 });
    expect(deliverableToken(rh, 'PLTR')).toEqual({ token: 'PLTR', decimals: 18 });
    expect(deliverableToken(rh, 'NFLX')).toBeUndefined();
    expect(deliverableToken(rh, 'ETH')).toEqual({ token: 'WETH', decimals: 18 });
    expect(deliverableToken(rh, 'BTC')).toBeUndefined();
    // Nothing anywhere for SOL, NVDA, AAPL, SPY: cash only.
    for (const s of ['BTC', 'SOL', 'NVDA', 'AAPL', 'SPY', 'META']) for (const chain of NOTE_CHAINS) expect(deliverableToken({ chain }, s)).toBeUndefined();
  });

  it('offers per-chain collateral, never a test token', () => {
    const arb = collateralChoices({});
    expect(arb).toEqual([
      { symbol: 'USD', token: 'USDG' }, { symbol: 'ETH', token: 'WETH' },
      { symbol: 'TSLA', token: null }, { symbol: 'AMZN', token: null }, { symbol: 'AMD', token: null }, { symbol: 'PLTR', token: null },
    ]);
    expect(collateralChoices({ chain: 'robinhood-testnet' })).toEqual([
      { symbol: 'USD', token: 'USDG' }, { symbol: 'ETH', token: 'WETH' },
      { symbol: 'TSLA', token: 'TSLA' }, { symbol: 'AMZN', token: 'AMZN' }, { symbol: 'AMD', token: 'AMD' }, { symbol: 'PLTR', token: 'PLTR' },
    ]);
    // Locked on Robinhood for an Arbitrum note: the vault's assets (gateway v2 receipts); ETH stays on its own chain.
    expect(collateralChoices({ collateralChain: 'robinhood' })).toEqual([
      { symbol: 'USD', token: 'USDG.rh' }, { symbol: 'ETH', token: null },
      { symbol: 'TSLA', token: 'TSLA.rh' }, { symbol: 'AMZN', token: 'AMZN.rh' }, { symbol: 'AMD', token: 'AMD.rh' }, { symbol: 'PLTR', token: 'PLTR.rh' },
    ]);
    for (const chain of NOTE_CHAINS) for (const cc of ['note', 'robinhood'] as const) {
      for (const c of collateralChoices({ chain, collateralChain: cc })) if (c.token) expect(isRetiredTestToken(c.token)).toBe(false);
    }
  });

  it('compiles the chain into the definition: TSLA is delivered on Robinhood Chain only', () => {
    expect(instantiateProduct({ ...rc, chain: 'robinhood-testnet' }).assets.find(a => a.id === 'd_TSLA')).toMatchObject({ token: 'TSLA', decimals: 18 });
    expect(validateProductParams(rc).join(' ')).toMatch(/no TSLA token to deliver on Arbitrum Sepolia/);
    const eth: ProductParams = { ...rc, underlyings: [FEEDS.ETH] };
    expect(instantiateProduct(eth).assets.find(a => a.id === 'd_ETH')).toMatchObject({ token: 'WETH', decimals: 18 });
    expect(compileTemplate({ product: { ...eth, chain: 'robinhood-testnet' } }).hash).not.toEqual(compileTemplate({ product: eth }).hash);
  });

  it('refuses tokens a chain does not have, and an unknown chain', () => {
    const amzn: ProductParams = { ...EXAMPLE_PRODUCTS.phoenix, collateral: [{ symbol: 'AMZN', haircutPct: 60 }] };
    expect(validateProductParams(amzn).join(' ')).toMatch(/no AMZN token to pledge on Arbitrum Sepolia.*lock TSLA or AMZN on Robinhood Chain/);
    expect(validateProductParams({ ...amzn, chain: 'robinhood-testnet' })).toEqual([]);
    expect(validateProductParams({ ...amzn, collateralChain: 'robinhood' })).toEqual([]);
    expect(validateProductParams({ ...amzn, chain: 'nasdaq' as never }).join(' ')).toMatch(/chain must be one of/);
    // BTC is synthetic: never collateral, on either chain.
    const btc = { ...EXAMPLE_PRODUCTS.phoenix, collateral: [{ symbol: 'BTC', haircutPct: 70 }] } as unknown as ProductParams;
    for (const chain of NOTE_CHAINS) expect(validateProductParams({ ...btc, chain }).join(' ')).toMatch(/'BTC' cannot be pledged/);
    const eth: ProductParams = { ...EXAMPLE_PRODUCTS.phoenix, collateral: [{ symbol: 'ETH', haircutPct: 70 }] };
    for (const chain of NOTE_CHAINS) expect(validateProductParams({ ...eth, chain })).toEqual([]);
    const solPhysical: ProductParams = { ...EXAMPLE_PRODUCTS.fcn, underlyings: [FEEDS.SOL], settlement: 'physical' };
    expect(validateProductParams(solPhysical).join(' ')).toMatch(/no SOL token to deliver on Arbitrum Sepolia/);
    expect(validateProductParams({ ...solPhysical, settlement: 'cash' })).toEqual([]);
    expect(validateProductParams({ ...EXAMPLE_PRODUCTS.phoenix, chain: 'robinhood-testnet', collateralChain: 'robinhood' }).join(' ')).toMatch(/holds its collateral there already/);
  });

  it('settles in USDG on both testnets', () => {
    expect(instantiateProduct({ ...rc, settlement: 'cash' }).assets.find(a => a.id === 'cash')).toMatchObject({ token: 'USDG', decimals: 6 });
    expect(instantiateProduct({ ...rc, chain: 'robinhood-testnet' }).assets.find(a => a.id === 'cash')).toMatchObject({ token: 'USDG', decimals: 6 });
  });

  it('fixes each asset on its native chain\'s oracle: equities on Robinhood Chain, crypto on Ethereum', () => {
    expect(FEEDS.AMZN).toMatchObject({ feed: '0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C', feedChain: 'robinhood-mainnet', staleness: 345_600 });
    expect(FEEDS.TSLA.feed).toBe('0x4A1166a659A55625345e9515b32adECea5547C38');
    for (const s of ['TSLA', 'AMZN', 'AMD', 'PLTR', 'NVDA', 'AAPL', 'SPY', 'META', 'MSFT', 'GOOGL', 'COIN'] as const) expect(FEEDS[s].feedChain).toBe('robinhood-mainnet');
    for (const s of ['ETH', 'BTC', 'SOL'] as const) expect(FEEDS[s].feedChain).toBe('ethereum-mainnet');
    // Collateral is valued by the same feed as the asset itself.
    const p: ProductParams = { ...EXAMPLE_PRODUCTS.phoenix, chain: 'robinhood-testnet', collateral: [{ symbol: 'TSLA', haircutPct: 60 }] };
    expect(JSON.stringify(instantiateProduct(p).bpmnXml)).toContain(FEEDS.TSLA.feed);
  });

  it('reads term sheets saved with the retired stockTokens switch', () => {
    const old = { ...rc, stockTokens: 'robinhood' } as ProductParams;
    expect(normalizeParams(old)).toEqual({ ...rc, chain: 'robinhood-testnet' });
    expect(normalizeParams({ ...rc, stockTokens: 'test' } as ProductParams)).toEqual(rc);
    expect(normalizeParams(rc)).toBe(rc);
  });

  it('maps collateral asset names, old and new, to their symbols', () => {
    expect(collateralSymbolOfAsset('Collateral WETH')).toBe('ETH');
    expect(collateralSymbolOfAsset('Collateral TSLA.rh')).toBe('TSLA');
    expect(collateralSymbolOfAsset('Collateral USDG.rh')).toBe('USD');
    expect(collateralSymbolOfAsset('Collateral tUSD')).toBe('USD');
    expect(collateralSymbolOfAsset('Collateral tETH')).toBe('ETH');
    expect(collateralSymbolOfAsset('USDG')).toBeNull();
  });
});

describe('the ready-made library', () => {
  it('uses only real tokens, and every entry validates', () => {
    for (const t of SEED_TEMPLATES) {
      const p = t.source.product ?? t.source.basis!;
      expect(validateProductParams(p), t.name).toEqual([]);
      const tokens = t.source.assets?.map(a => a.token ?? '') ?? tokensOf(p);
      for (const tok of tokens) expect(isRetiredTestToken(tok) || tok === 'tUSD', `${t.name}: ${tok}`).toBe(false);
      expect(templateOffered(t.source)).toBe(true);
    }
  });

  it('ships the two Robinhood Chain templates, valid and compiled', () => {
    const rh = SEED_TEMPLATES.filter(t => t.source.product?.chain === 'robinhood-testnet');
    expect(rh.map(t => t.name)).toEqual(['12M Worst-of Phoenix on TSLA, AMZN', '12M Reverse Convertible on TSLA, physical']);
    for (const t of rh) expect(compileTemplate(t.source).hash.length).toBe(32);
    expect(tokensOf(rh[1].source.product!)).toContain('TSLA');
    expect(tokensOf(rh[0].source.product!)).toContain('TSLA');
  });

  it('stops listing saved templates that name a retired test token or no longer validate', () => {
    const oldAapl = { product: { ...EXAMPLE_PRODUCTS['reverse-convertible'], underlyings: [FEEDS.AAPL], settlement: 'physical' as const } };
    expect(templateOffered(oldAapl)).toBe(false);
    const { bpmnXml, assets } = instantiateProduct(EXAMPLE_WORST_OF);
    expect(templateOffered({ bpmnXml, assets })).toBe(true);
    expect(templateOffered({ bpmnXml, assets: assets.map(a => (a.token === 'USDG' && a.id !== 'cash' ? { ...a, token: 'tETH' } : a)) })).toBe(false);
    expect(RETIRED_TEST_TOKENS).toContain('tTSLA');
    expect(isRetiredTestToken('tTSLA.rh')).toBe(true);
    expect(isRetiredTestToken('tUSD')).toBe(false);
  });
});

describe('collateral locked on Robinhood Chain (cross-chain receipts)', () => {
  const phoenix: ProductParams = {
    ...EXAMPLE_PRODUCTS.phoenix, name: 'Phoenix on TSLA, collateral on Robinhood', underlyings: [FEEDS.TSLA],
    collateralChain: 'robinhood', collateral: [{ symbol: 'TSLA', haircutPct: 60 }, { symbol: 'USD', haircutPct: 100 }],
  };
  it('pledges the receipts minted on Arbitrum, valued like the token itself', () => {
    expect(collateralTokenOf(phoenix, 'TSLA')).toEqual({ token: 'TSLA.rh', decimals: 18 });
    expect(collateralTokenOf(phoenix, 'USD')).toEqual({ token: 'USDG.rh', decimals: 6 });
    expect(validateProductParams(phoenix)).toEqual([]);
    const tokens = tokensOf(phoenix);
    expect(tokens).toContain('TSLA.rh');
    expect(tokens).toContain('USDG.rh');
  });
  it('locks only the vault\'s assets (USDG, TSLA, AMZN, AMD, PLTR): ETH stays on its own chain', () => {
    expect(collateralTokenOf({ collateralChain: 'robinhood' }, 'ETH')).toBeUndefined();
    expect(validateProductParams({ ...phoenix, collateral: [{ symbol: 'ETH', haircutPct: 70 }] }).join(' ')).toMatch(/ETH can't be locked on Robinhood Chain/);
    expect(validateProductParams({ ...phoenix, collateral: [{ symbol: 'AMD', haircutPct: 60 }] })).toEqual([]);
    expect(collateralTokenOf({ collateralChain: 'robinhood' }, 'PLTR')).toEqual({ token: 'PLTR.rh', decimals: 18 });
  });
  it('leaves notes without the option (and their template ids) unchanged', () => {
    expect(collateralTokenOf({}, 'USD')).toEqual(collateralTokenOf({ collateralChain: 'note' }, 'USD'));
  });
});
