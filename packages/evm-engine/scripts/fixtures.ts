/**
 * Fixtures for test/Products.t.sol: every structured product, compiled by packages/core, with the price
 * path to drive it along and what each holder must end up with according to the REFERENCE payoff
 * (packages/core/src/products/payoff.ts). The same runs drove the hackathon's Solana engine
 * (StratosNotes packages/flow/test/products.e2e.test.ts).
 *
 * Each run is ABI-encoded as the `Fixture` struct in test/Products.t.sol and written to
 * test/fixtures/products.json. Run: npm run fixtures (from packages/evm-engine).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, toHex } from 'viem';
import {
  compile, compileTemplate, dec, DELIVERABLE, EXAMPLE_PRODUCTS, EXAMPLE_WORST_OF, evmInput, FEEDS, instantiateProduct, parseBpmn,
  reservePerUnit, SEED_TEMPLATES, simulateWorstOf, totalPerUnit, type ProductParams, type ProductType, type TemplateSource,
} from '@sn/core';

/** Block time the Foundry test warps to before each run (fixed, so dates can be baked in). */
export const T0 = 1_900_000_000;
const STRIKES: Record<string, number> = { ETH: 2000, BTC: 60000, SOL: 150 };
const TOKEN_ID: Record<string, number> = { tUSD: 1, tETH: 2, tBTC: 3, tSOL: 4 };

interface Run {
  type: ProductType; path: number[] | number[][]; investors: number[]; transfer?: number; params?: ProductParams;
  source?: TemplateSource; perUnit?: number; paFee?: number;
}
const seed = (part: string) => SEED_TEMPLATES.find(t => t.name.includes(part))!.source;
const ETH_BTC: ProductParams = { ...EXAMPLE_PRODUCTS.fcn, name: '12M Worst-of FCN on ETH, BTC', underlyings: [FEEDS.ETH, FEEDS.BTC] };
const PHYS_ETH: ProductParams = { ...EXAMPLE_PRODUCTS.fcn, name: '12M FCN on ETH, physical', settlement: 'physical' };
const PHYS_BASKET: ProductParams = { ...EXAMPLE_PRODUCTS['reverse-convertible'], name: '12M Worst-of RC on ETH, BTC, SOL, physical', underlyings: [FEEDS.ETH, FEEDS.BTC, FEEDS.SOL], settlement: 'physical' };
const PHOENIX_NO_MEMORY: ProductParams = { ...EXAMPLE_PRODUCTS.phoenix, name: '12M Phoenix (no memory) on ETH', memory: false };

const RUNS: Run[] = [
  { type: 'fcn', path: [90, 104, 0, 0], investors: [600, 400] }, // autocalled at 2
  { type: 'fcn', path: [90, 95, 80, 50], investors: [700, 300] }, // knocked in: cash-settled at 0.5
  { type: 'reverse-convertible', path: [95, 80, 75, 65], investors: [500, 500] },
  { type: 'phoenix', path: [60, 65, 80, 75], investors: [250, 750], transfer: 100 }, // memory catches up at 3; part of a position changes hands
  { type: 'phoenix', params: PHOENIX_NO_MEMORY, path: [60, 65, 80, 75], investors: [500, 500] }, // no memory: missed coupons are lost
  { type: 'snowball', path: [90, 95, 99, 101], investors: [900, 100] }, // called at maturity
  { type: 'ppn', path: [130], investors: [400, 600] },
  // Worst-of: SOL misses the coupon barrier at 1; at 2 every asset is above 100%: two coupons (memory) and the call.
  { type: 'phoenix', params: EXAMPLE_WORST_OF, path: [[110, 120, 60], [105, 102, 101], [0, 0, 0], [0, 0, 0]], investors: [300, 700] },
  // Worst-of: ETH falls to 50% at maturity while BTC is fine: cash-settled on the worst performer.
  { type: 'fcn', params: ETH_BTC, path: [[95, 90], [90, 85], [80, 99], [50, 90]], investors: [600, 400] },
  // Seed template (custom workflow). Step-down: 96% at Q3 calls (level 95%), where the stock phoenix would not.
  { type: 'phoenix', source: seed('Step-down'), params: seed('Step-down').basis, path: [80, 90, 96, 0], investors: [500, 500], perUnit: 1.075 },
  // Physical delivery: knocked in, each holder receives units / strike of ETH (single) or of the worst performer (SOL here).
  { type: 'fcn', params: PHYS_ETH, path: [90, 95, 80, 50], investors: [700, 300] },
  { type: 'reverse-convertible', params: PHYS_BASKET, path: [[95, 90, 92], [90, 85, 80], [80, 99, 75], [90, 95, 55]], investors: [400, 600] },
  // Servicing fee: investors get the plain phoenix payoff; the paying agent collects 0.1% of 1,000 with each of the 2 coupons paid.
  { type: 'phoenix', source: seed('servicing fee'), params: seed('servicing fee').basis, path: [60, 65, 80, 75], investors: [500, 500], paFee: 2 },
];

const paramsOf = (r: Run) => r.params ?? EXAMPLE_PRODUCTS[r.type];
const rows = (r: Run) => (r.path as Array<number | number[]>).map(x => (Array.isArray(x) ? x : [x]));
const base = (x: number, decimals: number) => BigInt(Math.ceil(x * 10 ** decimals));

const FIXTURE = [{
  type: 'tuple', components: [
    { name: 'name', type: 'string' },
    { name: 'def', type: 'bytes' },
    { name: 'tokenOf', type: 'uint8[]' },
    { name: 'startStep', type: 'uint16' },
    { name: 'approveStep', type: 'uint16' },
    { name: 'mandateStep', type: 'uint16' },
    { name: 'subscribeStep', type: 'uint16' },
    { name: 'fixStrikeStep', type: 'uint16' },
    { name: 'observeSteps', type: 'uint16[]' },
    { name: 'approveInputs', type: 'tuple[]', components: [{ name: 'tag', type: 'uint8' }, { name: 'data', type: 'bytes32' }] },
    { name: 'issuerCash', type: 'uint256' },
    { name: 'reserves', type: 'tuple[]', components: [
      { name: 'step', type: 'uint16' }, { name: 'asset', type: 'uint8' }, { name: 'token', type: 'uint8' },
      { name: 'amount', type: 'int256' }, { name: 'base', type: 'uint256' },
    ] },
    { name: 'investorUnits', type: 'int256[]' },
    { name: 'investorCash', type: 'uint256[]' },
    { name: 'strikes', type: 'int256[]' },
    { name: 'obs', type: 'int256[][]' },
    { name: 'transferUnits', type: 'int256' },
    { name: 'expectedCash', type: 'int256[]' },
    { name: 'expectedDelivered', type: 'int256[]' },
    { name: 'deliveredAsset', type: 'uint8' },
    { name: 'paFee', type: 'int256' },
    { name: 'strikeAt', type: 'uint64' },
    { name: 'obsAt', type: 'uint64[]' },
  ],
}] as const;

function fixture(run: Run, idx: number) {
  const p = paramsOf(run);
  const c = run.source ? compileTemplate(run.source) : (() => {
    const prod = instantiateProduct(p);
    return compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params });
  })();
  const assets = run.source ? null : instantiateProduct(p).assets;
  // Which token backs each asset: USDC for cash, the deliverable token for a physical underlying.
  const tokenOf = c.def.assets.map((a, i) => {
    if (a.kind === 0) return 0;
    const t = assets?.[i]?.token;
    return t && t !== 'tUSD' ? TOKEN_ID[t] : TOKEN_ID.tUSD;
  });
  const strikes = p.underlyings.map(u => STRIKES[u.symbol]);
  const notional = run.investors.reduce((a, b) => a + b, 0);
  const reserve = Math.ceil(notional * (reservePerUnit(p) ?? (p.participationPct! / 100)));
  const strikeAt = T0 + 30;
  const obsAt = Array.from({ length: p.observations }, (_, k) => strikeAt + 5 * (k + 1));
  const approveInputs = [
    evmInput.text(`XS${String(idx).padStart(10, '0')}`), evmInput.number(dec(notional)), evmInput.number(BigInt(strikeAt)),
    ...obsAt.map(t => evmInput.number(BigInt(t))), evmInput.number(dec(reserve)),
  ];
  // Physical delivery: the issuer deposits enough of each token for every unit at its strike, plus 10%.
  const reserves = p.settlement === 'physical' ? p.underlyings.map((u, i) => {
    const d = DELIVERABLE[u.symbol];
    const amount = Math.ceil(notional / strikes[i] * 1.1 * 1e4) / 1e4;
    return {
      step: c.stepIndex[`Task_DeliveryReserve_${u.symbol}`], asset: c.def.assets.findIndex(a => a.name === d.token),
      token: TOKEN_ID[d.token], amount: dec(amount), base: base(amount, d.decimals),
    };
  }) : [];

  // Investors (and, after a partial transfer, the buyer) and what the reference payoff owes each.
  const ref = simulateWorstOf(p, strikes, rows(run).map(r => r.map((x, i) => strikes[i] * x / 100)));
  const knocked = p.settlement === 'physical' && !ref.calledAt && ref.redemptionCash < 1;
  const last = rows(run)[p.observations - 1];
  const worst = last.indexOf(Math.min(...last));
  const holders = run.investors.map(u => u);
  if (run.transfer) { holders[0] -= run.transfer; holders.push(run.transfer); }
  const perUnit = run.perUnit ?? (knocked ? ref.coupons.reduce((a, b) => a + b, 0) : totalPerUnit(ref));
  const deliveredAsset = knocked ? c.def.assets.findIndex(a => a.name === DELIVERABLE[p.underlyings[worst].symbol].token) : 0;

  const value = {
    name: p.name,
    def: toHex(c.bytes),
    tokenOf,
    startStep: c.stepIndex.Start_Issuer,
    approveStep: c.stepIndex.Task_ApproveTerms,
    mandateStep: c.stepIndex.Task_Mandate,
    subscribeStep: c.stepIndex.Task_Subscribe,
    fixStrikeStep: c.stepIndex.Task_FixStrike,
    observeSteps: Array.from({ length: p.observations }, (_, k) => c.stepIndex[`Task_Observe${k + 1}`]),
    approveInputs,
    // Custom templates may take more than the reserve (e.g. fees).
    issuerCash: base(reserve + (run.source ? notional / 100 : 0), 6),
    reserves,
    investorUnits: run.investors.map(u => dec(u)),
    investorCash: run.investors.map(u => base(u * p.issuePricePct / 100, 6)),
    strikes: strikes.map(s => dec(s)),
    obs: rows(run).map(r => r.map((x, i) => dec(strikes[i] * x / 100))),
    transferUnits: dec(run.transfer ?? 0),
    expectedCash: holders.map(u => dec((u * perUnit).toFixed(10))),
    expectedDelivered: holders.map(u => (knocked ? dec((u / strikes[worst]).toFixed(10)) : 0n)),
    deliveredAsset,
    paFee: dec(run.paFee ?? 0),
    strikeAt: BigInt(strikeAt),
    obsAt: obsAt.map(BigInt),
  };
  return encodeAbiParameters(FIXTURE, [value]);
}

const out = fileURLToPath(new URL('../test/fixtures/products.json', import.meta.url));
const runs = RUNS.map(fixture);
writeFileSync(out, JSON.stringify({ t0: T0, runs }, null, 1) + '\n');
console.log(`${runs.length} product runs -> ${out}`);
