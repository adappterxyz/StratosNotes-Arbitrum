// One structured note's lifecycle, step by step, and what each step is on-chain. Snippets follow the real
// code: FlowEngine.sol (packages/evm-engine), the SDK that calls it, and the CRE workflow (cre/notes-keeper-evm).

export type Chain = 'evm';

export interface LifecycleStep {
  id: string;
  type: 'event' | 'box' | 'gateway' | 'end';
  x: number;
  y: number;
  label: string;
  tag: string;
  title: string;
  desc: string;
  /** Who makes it happen. */
  actor: string;
  code: Record<Chain, string>;
}

const c = (s: string) => `<span class="cm">${s}</span>`;
const k = (s: string) => `<span class="kw">${s}</span>`;
const f = (s: string) => `<span class="fn">${s}</span>`;
const q = (s: string) => `<span class="st">${s}</span>`;

export const STEPS: LifecycleStep[] = [
  {
    id: 'terms', type: 'event', x: 8, y: 50, label: 'Term sheet',
    tag: 'Pre-trade · Issuer', title: 'Approve Terms', actor: 'Issuer',
    desc: 'Size, dates, settlement lag and grace period are set per issuance. The issuer pledges collateral at a ratio they choose: stablecoin, or tokens valued by Chainlink with a haircut. It stays locked in the note.',
    code: {
      evm: `${c('// The Issuer runs its user task on FlowEngine (Arbitrum Sepolia or Robinhood testnet)')}
engine.${f('executeStep')}(pid, Task_ApproveTerms, ${q('0')}, [
  isin, notional, strikeDate,
  obsDate1, obsDate2, obsDate3, obsDate4,
  reserve,
])
${c('// captures the fields, then the deposit op pulls `reserve`')}
${c('// tUSD from the issuer (approved for exactly that amount)')}`,
    },
  },
  {
    id: 'book', type: 'box', x: 25, y: 26, label: 'Subscribe',
    tag: 'Open book · Investors', title: 'Subscribe (DvP)', actor: 'Any investor',
    desc: 'Anyone subscribes until the strike date. Each subscription swaps stablecoins for note units atomically, and the proceeds go to the issuer as funding. Units can later be transferred in whole or in part.',
    code: {
      evm: `${c('// An OPEN role: anyone may run it, again and again,')}
${c('// until the strike date (a repeatable window)')}
Task_Subscribe: until = strikeDate
  ops = [
    ${f('deposit')}(tUSD, units * ${q('100 / 100')}),           ${c('// investor → engine')}
    ${f('swap')}(note: Issuer → Investor, units,
         tUSD: Investor → Issuer, units * ${q('100 / 100')}),
  ]
${c('// later: engine.transferUnits(pid, 0, to, amount): whole or part')}`,
    },
  },
  {
    id: 'strike', type: 'box', x: 42, y: 74, label: 'Fix strike',
    tag: 'Oracle step · Chainlink CRE', title: 'Fix Strike', actor: 'Chainlink CRE',
    desc: 'On the strike date the CRE workflow reads the Chainlink price feed at the finalized block and writes a DON-signed report; the ledger accepts it only from Chainlink and within the declared bounds.',
    code: {
      evm: `${c('// cre/notes-keeper-evm (Chainlink CRE)')}
${k('const')} values = due.feeds.${f('map')}(f => ${f('readFeed')}(runtime, f))  ${c('// at a finalized block')}
evm.${f('writeReport')}(runtime, {
  receiver: engine,                ${c('// through the KeystoneForwarder')}
  report: runtime.${f('report')}(${f('encodeAbiParameters')}(pid, Task_FixStrike, values)),
  gasConfig: { gasLimit: ${q('2800000')} },
})
${c('// FlowEngine.onReport: only the forwarder may call it;')}
${c('// every value bounds-checked, then straight-through')}`,
    },
  },
  {
    id: 'observe', type: 'box', x: 60, y: 26, label: 'Observe k',
    tag: 'Oracle step · Chainlink CRE', title: 'Observe on each date', actor: 'Chainlink CRE',
    desc: 'Each observation waits for its own date. One report fixes what the issuer owes this period and checks the collateral still covers the note; if not, the issuer gets a margin call.',
    code: {
      evm: `${c('// The same workflow, every date. The engine runs the step,')}
${c('// then everything after it in the same transaction:')}
Task_Observe2  timer = obsDate2, captures obs2 (oracle)
GW_Coupon2     ${k('if')} perf2 >= ${q('70 / 100')}       ${c('// perf = min(ETH, BTC) vs strike')}
Task_Coupon2   ${f('distribute')}(tUSD per unit ${q('2.5 / 100')} * (missed1 + 1))
GW_Autocall2   ${k('if')} perf2 >= ${q('100 / 100')}
${c('// a coupon to 30 holders: 1.18M gas (forge, cold)')}`,
    },
  },
  {
    id: 'autocall', type: 'gateway', x: 77, y: 74, label: 'Autocall?',
    tag: 'Gateway · predicate', title: 'Autocall check', actor: 'The ledger',
    desc: 'A gateway with a price predicate. The ledger evaluates it in exact decimal arithmetic; nobody chooses the branch, so nobody can choose the wrong one.',
    code: {
      evm: `${c('// BPMN exclusive gateway → engine predicate (fixed point, int256)')}
GW_Autocall2:
  Autocall  ${k('when')} perf2 >= ${q('100 / 100')}
  Continue  ${k('default')}
${c('// a branch is taken only when its fields are set;')}
${c('// nobody can override a conditioned gateway')}`,
    },
  },
  {
    id: 'redeem', type: 'end', x: 93, y: 50, label: 'Redeem',
    tag: 'Settlement · every holder', title: 'Fund, pay or default', actor: 'Holders',
    desc: 'The issuer funds each coupon and the redemption by the payment date plus a grace period of up to 7 days. Funded: every holder is paid and, at the end, the collateral is released. Not funded: the note defaults and the collateral goes to holders pro rata.',
    code: {
      evm: `${c('// distribute + retire: every holder in the ledger')}
Task_Autocall2   ${f('distribute')}(tUSD per unit ${q('1')}, retire)
${c('// then, by each holder, whenever they like:')}
engine.${f('withdraw')}(pid, CASH, owed)
${c('// local fork run: 600 / 400 units → 630 / 420 tUSD')}`,
    },
  },
];

export const EDGES: Array<[string, string]> = [['terms', 'book'], ['book', 'strike'], ['strike', 'observe'], ['observe', 'autocall'], ['autocall', 'redeem']];
