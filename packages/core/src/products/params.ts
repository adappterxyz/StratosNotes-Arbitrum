/**
 * ProductParams: the typed term sheet of a structured product (Flow's
 * products/params.ts, for Solana). A product is instantiated into a BPMN
 * workflow from these parameters, never authored free-hand, so every issued
 * note runs one of a small set of tested payoff engines.
 *
 * Units: one note unit has a face value of 1 unit of the cash token (USDG, Paxos' Global Dollar).
 * Percentages are of face (coupons, protection) or of the strike (barriers,
 * autocall level). Settlement is in cash: below the knock-in barrier a holder
 * receives final / strike per unit.
 *
 * Several underlyings make a worst-of note: every barrier, autocall and
 * redemption looks at the worst performer, min(level_i / strike_i).
 *
 * Economics (docs/NOTE-ECONOMICS.md): a note raises funds for the issuer against
 * pledged collateral. Subscriptions go to the issuer, withdrawable at once. The
 * issuer pledges collateral into the note's escrow at Approve Terms (stablecoin,
 * or tokens valued by Chainlink feeds after a haircut), at least
 * `collateralRatioPct` % of the outstanding notional, checked at the strike and at
 * every observation (margin call, then default if not cured within the grace
 * period). Each observation fixes what is owed; the issuer funds it into escrow
 * before the payment date (observation + settlement lag) or within the grace
 * period after it; unfunded at the end of grace, the note defaults and the escrow
 * (collateral and any partial funding) goes to the holders pro rata. After the
 * final payment the collateral is released to the issuer.
 */

export type ProductType = 'fcn' | 'reverse-convertible' | 'phoenix' | 'snowball' | 'ppn';

export interface Underlying {
  symbol: string;
  /** Chainlink price feed (EVM AggregatorV3) the CRE workflow reads. */
  feed: string;
  /** CRE chain selector name of the feed's chain. */
  feedChain: string;
  /** Bounds every observed price must sit in (checked on-chain). */
  minPrice: number;
  maxPrice: number;
  /** Oldest acceptable round, seconds: the feed's heartbeat (default 3600). */
  staleness?: number;
}

/** A collateral asset the issuer may pledge: the stablecoin (USD) or a token valued by its Chainlink feed. */
export type CollateralSymbol = 'USD' | 'ETH' | 'BTC' | 'SOL' | 'TSLA' | 'NVDA' | 'AAPL' | 'SPY' | 'AMZN';
export interface CollateralTerm {
  symbol: CollateralSymbol;
  /** Value counted toward coverage, % of market value (USD 100; volatile tokens lower). Per issuance, 0–100. */
  haircutPct: number;
}

export interface ProductParams {
  productType: ProductType;
  name: string;
  /** Subscription price in % of face (100 = par). */
  issuePricePct: number;
  /** One underlying, or a worst-of basket (up to MAX_UNDERLYINGS). */
  underlyings: Underlying[];
  /**
   * Below the knock-in barrier: `cash` pays final / strike in USDG; `physical`
   * delivers units / strike of the (worst) underlying's token instead, from a
   * delivery reserve the issuer deposits at pre-trade. Default cash.
   */
  settlement?: 'cash' | 'physical';
  /** Number of observations per issuance; the last one is maturity. Dates are set per issuance at pre-trade. */
  observations: number;
  couponRatePct?: number;
  couponBarrierPct?: number;
  memory?: boolean;
  autocallLevelPct?: number;
  autocallFromPeriod?: number;
  knockInBarrierPct?: number;
  protectionPct?: number;
  participationPct?: number;
  /** What the issuer may pledge (up to MAX_COLLATERAL assets). Default: the stablecoin at 100%. */
  collateral?: CollateralTerm[];
  /** Required collateral value, % of the outstanding notional (default for the issue form; set per issuance). */
  collateralRatioPct?: number;
  /** Days from an observation to its payment date (default; set per issuance, in seconds, at Approve Terms). */
  settlementLagDays?: number;
  /** Days of grace after a missed payment date or margin call, 0–7 (default; set per issuance). */
  gracePeriodDays?: number;
  /**
   * DEFAULT RULE: what the holders get from escrow when the note defaults.
   *  'cap-at-owed' (default): what they are owed (the missed payment plus par, valued at the last oracle
   *    prices, stablecoin first), and the rest of the escrow back to the issuer.
   *  'all-to-holders': everything in escrow, whatever it is worth.
   */
  defaultRule?: DefaultRule;
  /**
   * Which stock tokens a physically settled note delivers and a stock collateral pledge uses:
   *  'test' (default): notes.markets' own test tokens (tTSLA, tNVDA…), deployed on every testnet here.
   *  'robinhood': Robinhood Chain's own testnet stock tokens (TSLA, AMZN, NFLX; 18 decimals), for notes issued
   *    on Robinhood Chain next to the stocks. Stocks Robinhood does not publish still fall back to the test tokens.
   * Token decimals are compiled into the definition, so this is part of the note's design, not just a network choice.
   */
  stockTokens?: StockTokens;
  /**
   * Where the collateral is held (docs/CROSS-CHAIN.md). Absent or 'note': the tokens are pledged into the note on
   * its own chain. 'robinhood': the issuer locks USDG, TSLA or AMZN in the vault on Robinhood Chain and pledges the
   * receipts (USDG.rh, TSLA.rh, AMZN.rh, and tETH.rh… for the test tokens) that Chainlink CCIP mints on Arbitrum; they are valued with the same
   * Chainlink feed and haircut as the token itself. Only for notes on Arbitrum Sepolia.
   */
  collateralChain?: CollateralChain;
  /**
   * How holders receive their payouts once the note has been paid (docs/ERC20-NOTES.md, "Why claim by default").
   * Either way Chainlink CRE pays each coupon and the redemption INTO the note on its payment date; this is only the
   * last hop, from the note to the holder's wallet.
   *  'claim' (default, also when absent): holders claim from their portfolio whenever they like and pay their own
   *    gas. Payouts accrue until then; one claim collects everything, with a receipt (PayoutPaid) per claim.
   *  'push': the issuer's bot sends each payout to every holder's wallet (pushPayouts), and the issuer pays the gas
   *    (about 55k gas per holder per payment). Holders can still claim at any time.
   * It is read by people and bots only (the term sheet travels in the definition's META), never by the engine.
   */
  payouts?: PayoutMethod;
}

export type PayoutMethod = 'claim' | 'push';
export const PAYOUT_METHODS: readonly PayoutMethod[] = ['claim', 'push'];
/** The note's payout method: 'claim' unless its terms opt in to 'push'. */
export const payoutMethodOf = (p: Pick<ProductParams, 'payouts'> | null | undefined): PayoutMethod => (p?.payouts === 'push' ? 'push' : 'claim');

export type StockTokens = 'test' | 'robinhood';
export type CollateralChain = 'note' | 'robinhood';
/** Receipts on Arbitrum for collateral locked on Robinhood Chain (deployments/crosschain-testnet.json). NFLX has no
 * CRE-readable feed, so its receipt exists but is not offered as collateral. */
export const REMOTE_COLLATERAL: Record<string, Partial<Record<CollateralSymbol, { token: string; decimals: number }>>> = {
  robinhood: {
    USD: { token: 'USDG.rh', decimals: 6 }, TSLA: { token: 'TSLA.rh', decimals: 18 }, AMZN: { token: 'AMZN.rh', decimals: 18 },
    // notes.markets test tokens on Robinhood Chain testnet (no native token there yet), vaulted the same way.
    ETH: { token: 'tETH.rh', decimals: 9 }, BTC: { token: 'tBTC.rh', decimals: 8 }, SOL: { token: 'tSOL.rh', decimals: 9 },
    NVDA: { token: 'tNVDA.rh', decimals: 9 }, AAPL: { token: 'tAAPL.rh', decimals: 9 }, SPY: { token: 'tSPY.rh', decimals: 9 },
  },
};

export type DefaultRule = 'cap-at-owed' | 'all-to-holders';
export const DEFAULT_RULES: DefaultRule[] = ['cap-at-owed', 'all-to-holders'];

export const MAX_COLLATERAL = 3;
export const MAX_GRACE_DAYS = 7;
export const DEFAULT_HAIRCUT: Record<CollateralSymbol, number> = { USD: 100, ETH: 70, BTC: 70, SOL: 70, TSLA: 60, NVDA: 60, AAPL: 60, SPY: 60, AMZN: 60 };
export const COLLATERAL_SYMBOLS = Object.keys(DEFAULT_HAIRCUT) as CollateralSymbol[];
export const DEFAULT_COLLATERAL: CollateralTerm[] = [{ symbol: 'USD', haircutPct: 100 }];

/** The term sheet's economics with defaults filled in. */
export function economicsOf(p: ProductParams) {
  return {
    collateral: p.collateral?.length ? p.collateral : DEFAULT_COLLATERAL,
    collateralRatioPct: p.collateralRatioPct ?? 100,
    settlementLagDays: p.settlementLagDays ?? 2,
    gracePeriodDays: p.gracePeriodDays ?? 2,
    defaultRule: p.defaultRule ?? 'cap-at-owed' as DefaultRule,
  };
}

/**
 * The token an underlying is delivered in, for this note's stock-token choice: Robinhood Chain's own stock token
 * where the note uses them and Robinhood publishes one, else notes.markets' test token. Undefined when neither exists.
 */
export function deliverableToken(p: Pick<ProductParams, 'stockTokens'>, symbol: string): { token: string; decimals: number } | undefined {
  if (p.stockTokens === 'robinhood' && ROBINHOOD_STOCK_TOKENS[symbol]) return ROBINHOOD_STOCK_TOKENS[symbol];
  return DELIVERABLE[symbol];
}

/** The token behind a collateral asset (USD: the stablecoin), for this note's stock-token choice. */
export const collateralTokenOf = (p: Pick<ProductParams, 'stockTokens' | 'collateralChain'>, c: CollateralSymbol) =>
  (p.collateralChain && p.collateralChain !== 'note'
    ? REMOTE_COLLATERAL[p.collateralChain]?.[c]
    : (c === 'USD' ? CASH_TOKEN : deliverableToken(p, c)));

/** The token behind a collateral asset with notes.markets' test tokens (kept for callers without a term sheet). */
export const collateralToken = (c: CollateralSymbol) => collateralTokenOf({}, c);

export const PRODUCT_LABELS: Record<ProductType, string> = {
  'fcn': 'Fixed Coupon Note',
  'reverse-convertible': 'Reverse Convertible',
  'phoenix': 'Phoenix Autocallable',
  'snowball': 'Snowball Autocallable',
  'ppn': 'Principal-Protected Note',
};

export function productUses(t: ProductType) {
  return {
    coupon: t !== 'ppn',
    couponBarrier: t === 'phoenix',
    autocall: t === 'fcn' || t === 'phoenix' || t === 'snowball',
    knockIn: t !== 'ppn',
    protection: t === 'ppn',
  };
}

export const MAX_OBSERVATIONS = 12;
export const MAX_UNDERLYINGS = 3;

/** Term sheets stored before baskets had a single `underlying`: read either shape. */
export function normalizeParams(p: ProductParams & { underlying?: Underlying }): ProductParams {
  if (Array.isArray(p.underlyings) && p.underlyings.length) return p;
  const { underlying, ...rest } = p;
  return { ...rest, underlyings: underlying ? [underlying] : [] };
}

/** "ETH" or "worst of ETH, BTC". */
export const underlyingLabel = (p: ProductParams) =>
  p.underlyings.length > 1 ? `worst of ${p.underlyings.map(u => u.symbol).join(', ')}` : p.underlyings[0]?.symbol ?? '';
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;

export function validateProductParams(p: ProductParams): string[] {
  const e: string[] = [];
  const use = productUses(p.productType);
  if (!PRODUCT_LABELS[p.productType]) e.push(`Unknown product type '${p.productType}'.`);
  if (!p.name?.trim()) e.push('Give the product a name.');
  if (!(p.issuePricePct > 0)) e.push('Issue price must be positive (% of face).');
  const unds = p.underlyings ?? [];
  if (!unds.length) e.push('Add an underlying.');
  if (unds.length > MAX_UNDERLYINGS) e.push(`At most ${MAX_UNDERLYINGS} underlyings in a basket.`);
  if (new Set(unds.map(u => u.symbol)).size !== unds.length) e.push('Each underlying can appear once.');
  for (const u of unds) {
    if (!/^[A-Z][A-Z0-9]{0,9}$/.test(u.symbol ?? '')) e.push(`'${u.symbol}' is not a ticker (capital letters and digits).`);
    if (!EVM_ADDR.test(u.feed || '')) e.push(`The ${u.symbol} price feed must be a Chainlink feed address (0x…).`);
    if (!(u.minPrice >= 0 && u.maxPrice > u.minPrice)) e.push(`${u.symbol}: price bounds need 0 <= min < max.`);
  }
  if (!(Number.isInteger(p.observations) && p.observations >= 1 && p.observations <= MAX_OBSERVATIONS)) e.push(`Between 1 and ${MAX_OBSERVATIONS} observations.`);
  if (use.coupon && !(Number(p.couponRatePct) > 0)) e.push('Set a positive coupon rate per period.');
  if (use.couponBarrier && !(Number(p.couponBarrierPct) > 0)) e.push('A phoenix needs a coupon barrier (% of strike).');
  if (use.autocall) {
    if (!(Number(p.autocallLevelPct) > 0)) e.push('Set the autocall level (% of strike).');
    const from = p.autocallFromPeriod ?? 1;
    if (!(Number.isInteger(from) && from >= 1 && from <= p.observations)) e.push('The first autocall observation must be within the schedule.');
  }
  if (use.knockIn) {
    if (!(Number(p.knockInBarrierPct) > 0)) e.push('Set the knock-in barrier (% of strike).');
    if (use.autocall && Number(p.knockInBarrierPct) >= Number(p.autocallLevelPct)) e.push('The knock-in barrier must be below the autocall level.');
    if (use.couponBarrier && Number(p.knockInBarrierPct) > Number(p.couponBarrierPct)) e.push('The knock-in barrier must not be above the coupon barrier.');
  }
  if (p.settlement === 'physical') {
    if (!use.knockIn) e.push('Physical delivery applies below a knock-in barrier: this payoff has none.');
    for (const u of unds) if (!deliverableToken(p, u.symbol)) e.push(`There is no deliverable token for ${u.symbol}${p.stockTokens === 'robinhood' ? ' on Robinhood Chain' : ''}: settle in cash, or pick another underlying.`);
  }
  if (use.protection) {
    if (!(Number(p.protectionPct) > 0 && Number(p.protectionPct) <= 100)) e.push('Protection must be between 0 and 100% of face.');
    if (!(Number(p.participationPct) >= 0)) e.push('Participation must be zero or positive.');
  }
  const eco = economicsOf(p);
  if (eco.collateral.length > MAX_COLLATERAL) e.push(`At most ${MAX_COLLATERAL} collateral assets.`);
  if (new Set(eco.collateral.map(c => c.symbol)).size !== eco.collateral.length) e.push('Each collateral asset can appear once.');
  for (const c of eco.collateral) {
    if (!COLLATERAL_SYMBOLS.includes(c.symbol)) e.push(`'${c.symbol}' cannot be pledged: use ${COLLATERAL_SYMBOLS.join(', ')}.`);
    else if (!collateralTokenOf(p, c.symbol)) e.push(p.collateralChain === 'robinhood'
      ? `${c.symbol} can't be locked on Robinhood Chain: pledge USD (USDG), TSLA or AMZN there.`
      : `There is no ${c.symbol} token to pledge${p.stockTokens === 'robinhood' ? '' : ' with the test tokens: use Robinhood Chain\'s stock tokens'}.`);
    if (!(c.haircutPct >= 0 && c.haircutPct <= 100)) e.push(`${c.symbol} collateral: the haircut must be between 0 and 100% (the share of market value counted).`);
  }
  if (!(eco.collateralRatioPct >= 0 && eco.collateralRatioPct <= 1000)) e.push('The collateral ratio must be between 0 and 1,000% of the outstanding notional.');
  if (!(eco.settlementLagDays >= 0 && eco.settlementLagDays <= 30)) e.push('The settlement lag must be between 0 and 30 days.');
  if (p.collateralChain !== undefined && !['note', 'robinhood'].includes(p.collateralChain)) e.push('Collateral must be held on the note\'s chain or on Robinhood Chain.');
  if (p.stockTokens !== undefined && !STOCK_TOKEN_SETS.includes(p.stockTokens)) e.push(`Stock tokens must be one of ${STOCK_TOKEN_SETS.join(', ')}.`);
  if (p.payouts !== undefined && !PAYOUT_METHODS.includes(p.payouts)) e.push(`Payouts must be one of ${PAYOUT_METHODS.join(', ')}.`);
  if (!DEFAULT_RULES.includes(eco.defaultRule)) e.push(`The default rule must be one of ${DEFAULT_RULES.join(', ')}.`);
  if (!(eco.gracePeriodDays >= 0 && eco.gracePeriodDays <= MAX_GRACE_DAYS)) e.push(`The grace period must be between 0 and ${MAX_GRACE_DAYS} days.`);
  // The engine holds 8 assets per note: the note, the stablecoin, deliverable tokens and collateral together.
  const nAssets = 2 + (p.settlement === 'physical' ? unds.length : 0) + eco.collateral.length;
  if (nAssets > 8) e.push(`This note would hold ${nAssets} assets; the engine holds 8 (note, stablecoin, ${p.settlement === 'physical' ? 'one deliverable token per underlying, ' : ''}and the collateral assets). Pledge fewer collateral assets.`);
  return e;
}

/** Most a period can call for per unit of face, excluding the final redemption (for the funding schedule). */
export function maxCouponPerUnit(p: ProductParams, k: number): number {
  const r = (p.couponRatePct ?? 0) / 100;
  if (p.productType === 'phoenix') return p.memory ? r * k : r;
  if (p.productType === 'fcn' || p.productType === 'reverse-convertible') return r;
  return 0;
}

/**
 * The cash leg: USDG (Global Dollar, issued by Paxos; the dollar Robinhood uses), 6 decimals, on both testnets
 * (CASH_TOKENS has the addresses). Paxos runs its faucet; notes.markets cannot mint it. tUSD, our own mintable test
 * dollar, stays deployed as a fallback (TEST_CASH_TOKEN) for local dev and for notes issued before USDG.
 */
export const CASH_TOKEN = { token: 'USDG', decimals: 6 };
export const TEST_CASH_TOKEN = { token: 'tUSD', decimals: 6 };

/**
 * USDG on each testnet (https://docs.paxos.com/guides/stablecoin/usdg/testnet), checked on 2026-10-24: symbol USDG,
 * 6 decimals, non-zero supply; on an Arbitrum Sepolia fork transfer and transferFrom delivered in full (no fee on
 * transfer). It is an upgradeable proxy whose admin roles can pause transfers and freeze or wipe an address
 * (pause(), freeze(), wipeFrozenAddress() exist behind AccessControl): see docs/SECURITY.md.
 */
export const CASH_TOKENS: Record<string, `0x${string}`> = {
  'arbitrum-sepolia': '0xFFC95faa3d63Cde504a05B567C600B78C0b41892',
  'robinhood-testnet': '0x7E955252E15c84f5768B83c41a71F9eba181802F',
};
export const CASH_FAUCET = 'https://faucet.paxos.com';

/** Our test tokens on the Arbitrum testnets (packages/evm-engine/src/test-tokens): each underlying's deliverable
 * token, for physically settled notes. */
export const DELIVERABLE: Record<string, { token: string; decimals: number }> = {
  ETH: { token: 'tETH', decimals: 9 },
  BTC: { token: 'tBTC', decimals: 8 },
  SOL: { token: 'tSOL', decimals: 9 },
  TSLA: { token: 'tTSLA', decimals: 9 },
  NVDA: { token: 'tNVDA', decimals: 9 },
  AAPL: { token: 'tAAPL', decimals: 9 },
  SPY: { token: 'tSPY', decimals: 9 },
};

export const STOCK_TOKEN_SETS: StockTokens[] = ['test', 'robinhood'];

/**
 * Robinhood Chain testnet's own stock tokens (ERC-20, 18 decimals). Checked on 2026-10-24 against
 * https://rpc.testnet.chain.robinhood.com: symbol, decimals and supply on-chain, and on a local fork a 1-token
 * transfer arrived in full (no fee on transfer) and approve set the allowance. They come from Robinhood's faucet
 * (https://faucet.testnet.chain.robinhood.com). NFLX has no Chainlink feed CRE can read, so it can be held but not
 * priced: it is listed for completeness and is neither an underlying nor collateral here.
 */
export const ROBINHOOD_STOCK_TOKENS: Record<string, { token: string; decimals: number }> = {
  TSLA: { token: 'TSLA', decimals: 18 },
  AMZN: { token: 'AMZN', decimals: 18 },
  NFLX: { token: 'NFLX', decimals: 18 },
};

/** Token addresses this app knows besides the ones each deployment records (the chain's own tokens). */
export const EXTERNAL_TOKENS: Record<string, Record<string, `0x${string}`>> = {
  'robinhood-testnet': {
    TSLA: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E',
    AMZN: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02',
    NFLX: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93',
  },
};

/** Where to get each chain's own stock tokens. */
export const STOCK_TOKEN_FAUCETS: Record<string, string> = { 'robinhood-testnet': 'https://faucet.testnet.chain.robinhood.com' };

// Chainlink price feeds (8 decimals) the CRE workflow reads; the testnets themselves have none.
// Crypto: Ethereum mainnet. ETH/USD and BTC/USD update at least hourly, SOL/USD at least daily.
// Equities: Arbitrum One (CRE reads it as ethereum-mainnet-arbitrum-1). They follow NYSE hours with a 24 h
// heartbeat, so they do not move from Friday's close to Monday's open: the staleness allowance is 4 days, which
// spans a weekend. Checked against Chainlink's feed directory and on-chain on 2026-10-23 (AMZN on 2026-10-24: it is
// the AMZN / USD AggregatorV3 proxy on Arbitrum One; NFLX/USD exists only as Data Streams there, so there is no NFLX).
export const FEEDS: Record<'ETH' | 'BTC' | 'SOL' | 'TSLA' | 'NVDA' | 'AAPL' | 'SPY' | 'AMZN', Underlying> = {
  ETH: { symbol: 'ETH', feed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', feedChain: 'ethereum-mainnet', minPrice: 1, maxPrice: 1_000_000, staleness: 3600 },
  BTC: { symbol: 'BTC', feed: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', feedChain: 'ethereum-mainnet', minPrice: 1, maxPrice: 10_000_000, staleness: 3600 },
  SOL: { symbol: 'SOL', feed: '0x4ffC43a60e009B551865A93d232E33Fce9f01507', feedChain: 'ethereum-mainnet', minPrice: 0.01, maxPrice: 100_000, staleness: 86400 },
  TSLA: { symbol: 'TSLA', feed: '0x3609baAa0a9b1f0FE4d6CC01884585d0e191C3E3', feedChain: 'ethereum-mainnet-arbitrum-1', minPrice: 1, maxPrice: 100_000, staleness: 345_600 },
  NVDA: { symbol: 'NVDA', feed: '0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F', feedChain: 'ethereum-mainnet-arbitrum-1', minPrice: 1, maxPrice: 100_000, staleness: 345_600 },
  AAPL: { symbol: 'AAPL', feed: '0x8d0CC5f38f9E802475f2CFf4F9fc7000C2E1557c', feedChain: 'ethereum-mainnet-arbitrum-1', minPrice: 1, maxPrice: 100_000, staleness: 345_600 },
  SPY: { symbol: 'SPY', feed: '0x46306F3795342117721D8DEd50fbcF6DF2b3cc10', feedChain: 'ethereum-mainnet-arbitrum-1', minPrice: 1, maxPrice: 100_000, staleness: 345_600 },
  AMZN: { symbol: 'AMZN', feed: '0xd6a77691f071E98Df7217BED98f38ae6d2313EBA', feedChain: 'ethereum-mainnet-arbitrum-1', minPrice: 1, maxPrice: 100_000, staleness: 345_600 },
};

const base = { issuePricePct: 100, underlyings: [FEEDS.ETH], observations: 4 };

/** A worst-of basket: the phoenix on the worst of ETH, BTC and SOL. */
export const EXAMPLE_WORST_OF: ProductParams = {
  ...base, productType: 'phoenix', name: '12M Worst-of Phoenix on ETH, BTC, SOL', underlyings: [FEEDS.ETH, FEEDS.BTC, FEEDS.SOL],
  couponRatePct: 3, couponBarrierPct: 70, memory: true, autocallLevelPct: 100, autocallFromPeriod: 2, knockInBarrierPct: 60,
};

/** One worked example per product (quarterly over a year on ETH/USD). */
export const EXAMPLE_PRODUCTS: Record<ProductType, ProductParams> = {
  'fcn': { ...base, productType: 'fcn', name: '12M Fixed Coupon Note on ETH', couponRatePct: 2, autocallLevelPct: 100, knockInBarrierPct: 60 },
  'reverse-convertible': { ...base, productType: 'reverse-convertible', name: '12M Reverse Convertible on ETH', couponRatePct: 2.5, knockInBarrierPct: 70 },
  'phoenix': { ...base, productType: 'phoenix', name: '12M Phoenix (memory) on ETH', couponRatePct: 2.5, couponBarrierPct: 70, memory: true, autocallLevelPct: 100, autocallFromPeriod: 2, knockInBarrierPct: 60 },
  'snowball': { ...base, productType: 'snowball', name: '12M Snowball on ETH', couponRatePct: 2.25, autocallLevelPct: 100, knockInBarrierPct: 65 },
  'ppn': { ...base, productType: 'ppn', name: '12M 100% Protected Note on ETH', observations: 1, protectionPct: 100, participationPct: 50 },
};
