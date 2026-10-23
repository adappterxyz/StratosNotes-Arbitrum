/**
 * The chain-neutral read model: what a note is, whatever chain runs it. The indexer stores it, the API serves
 * it, the app renders it, and every chain adapter produces it.
 *
 * A note's id is `<chain>:<engine>:<pid>`:
 *  - chain: a chain key from CHAINS (e.g. `arbitrum-sepolia`);
 *  - engine: the contract (EVM, lower-case 0x address) or package/party that runs it;
 *  - pid: the process id inside that engine.
 *
 * `noteView` turns a definition plus a note's state into what people read: terms, book, strikes, observations,
 * phase, the payoff so far. It is pure and runs in the indexer (for filter columns), the API (per request,
 * since the phase depends on the time) and the app.
 */
import {
  normalizeParams, PRODUCT_LABELS, SCALE, simulatePerf, totalPerUnit, underlyingLabel,
  type ProductParams, type WorkflowDef,
} from '@sn/core';

export type ChainFamily = 'evm';

export interface ChainInfo {
  key: string;
  family: ChainFamily;
  name: string;
  chainId?: number;
  testnet: boolean;
  explorer?: string;
  /** The stablecoin notes settle in on this chain (EVM: an ERC-20 address), when known. */
  stablecoin?: { symbol: string; address?: string; decimals: number };
  /** Whether Chainlink CRE can write reports here (else a note's reports come from the fallback keeper). */
  cre: boolean;
}

/** Known chains. RPCs and engine addresses come from deployment config, not from here. */
export const CHAINS: Record<string, ChainInfo> = {
  'arbitrum-sepolia': { key: 'arbitrum-sepolia', family: 'evm', name: 'Arbitrum Sepolia', chainId: 421614, testnet: true, explorer: 'https://sepolia.arbiscan.io', cre: true,
    stablecoin: { symbol: 'tUSD', decimals: 6 } },
  'robinhood-testnet': { key: 'robinhood-testnet', family: 'evm', name: 'Robinhood Chain testnet', chainId: 46630, testnet: true, explorer: 'https://explorer.testnet.chain.robinhood.com', cre: true,
    stablecoin: { symbol: 'tUSD', decimals: 6 } },
  // Config only (no deployment yet): mainnet settlement in real stablecoins.
  'arbitrum-one': { key: 'arbitrum-one', family: 'evm', name: 'Arbitrum One', chainId: 42161, testnet: false, explorer: 'https://arbiscan.io', cre: true,
    stablecoin: { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 } },
  'robinhood-mainnet': { key: 'robinhood-mainnet', family: 'evm', name: 'Robinhood Chain', chainId: 4663, testnet: false, explorer: 'https://robinhoodchain.blockscout.com', cre: false,
    stablecoin: { symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 } },
  // Local anvil fork of Arbitrum Sepolia (scripts/dev-local.sh): same chain id, local RPC.
  'local': { key: 'local', family: 'evm', name: 'Local fork (Arbitrum Sepolia)', chainId: 421614, testnet: true, cre: true,
    stablecoin: { symbol: 'tUSD', decimals: 6 } },
};

export type NoteId = string;

export const noteId = (chain: string, engine: string, pid: string | bigint): NoteId => `${chain}:${engine.toLowerCase()}:${pid.toString()}`;

export function parseNoteId(id: string): { chain: string; engine: string; pid: string } | null {
  const m = /^([a-z0-9-]{1,40}):(0x[0-9a-f]{40}|[A-Za-z0-9_.:-]{1,200}):(\d{1,78})$/.exec(id);
  return m ? { chain: m[1], engine: m[2], pid: m[3] } : null;
}

/** Field value tags, as the engine stores them: number (fixed point or integer), text, party. */
export const TAG = { NUMBER: 1, TEXT: 2, PARTY: 3 } as const;

/** A captured field, JSON-safe: numbers as decimal strings (engine fixed point for decimals, plain for dates). */
export type FieldValue =
  | { tag: 1; value: string }
  | { tag: 2; value: string }
  | { tag: 3; value: string };

/** One account's balance of one asset in a note, engine fixed point (10 decimals) as a decimal string. */
export interface Holding { asset: number; owner: string; balance: string }

export interface ReportStats { cre: number; fallback: number; last: 'cre' | 'fallback' | null }

/** A note's state, as the chain holds it (JSON-safe). */
export interface NoteState {
  id: NoteId;
  chain: string;
  engine: string;
  pid: string;
  definition: string;
  creator: string;
  ref: string;
  roles: string[];
  /** EVM: the ERC-20 behind each cash asset (zero address for issued assets). */
  assetTokens: string[];
  status: number;
  tokens: number[];
  stepsRun: number;
  values: Record<number, FieldValue>;
  holdings: Holding[];
  createdAt: number;
  updatedAt: number;
  reports: ReportStats;
}

export const NOTE_ASSET = 0;
export const CASH_ASSET = 1;
export const STATUS_COMPLETED = 1;

export type Phase = 'book' | 'fixing' | 'live' | 'redeemed';
export const PHASES: Phase[] = ['book', 'fixing', 'live', 'redeemed'];
export const PHASE_LABEL: Record<Phase, string> = { book: 'Book open', fixing: 'Fixing strike', live: 'Live', redeemed: 'Redeemed' };

export interface UnderlyingState {
  symbol: string;
  feed: string;
  feedChain: string;
  strike: number | null;
  /** Level at each observation so far. */
  observed: number[];
}

/** What people read about a note. */
export interface NoteView {
  id: NoteId;
  chain: string;
  name: string;
  /** The term sheet when the workflow is (or started from) a stock product. */
  params: ProductParams;
  hasTerms: boolean;
  /** Edited in the studio: the payoff is defined by the workflow, not a reference engine. */
  custom: boolean;
  label: string;
  underlyingText: string;
  issuer: string;
  isin: string;
  notional: number;
  sold: number;
  strikeDate: number;
  obsDates: number[];
  unds: UnderlyingState[];
  strikeFixed: boolean;
  /** Worst performance (level / strike) at each completed observation. */
  perfs: number[];
  phase: Phase;
  activeSteps: string[];
  /** Payoff so far along the observed path (null before the strike, or for custom workflows). */
  outcome: { calledAt?: number; finished: boolean; perUnit: number } | null;
  /** Paid out so far per unit (cash distributed to holders, from the ledger). */
  reports: ReportStats;
  createdAt: number;
  updatedAt: number;
}

const fixed = (s: string | undefined) => (s === undefined ? NaN : Number(BigInt(s)) / Number(SCALE));

/** A field's value by name: numbers come back as bigint (raw), text and parties as strings; null when unset. */
export function fieldOf(def: WorkflowDef, s: Pick<NoteState, 'values'>, name: string): bigint | string | null {
  const i = def.fields.findIndex(f => f.name === name);
  const v = i < 0 ? undefined : s.values[i];
  if (!v) return null;
  return v.tag === TAG.NUMBER ? BigInt(v.value) : v.value;
}

export function termsOf(def: WorkflowDef): { params: ProductParams; hasTerms: boolean; custom: boolean } {
  let meta: { product?: ProductParams; custom?: boolean } = {};
  try { meta = JSON.parse(def.meta); } catch { /* a workflow without metadata */ }
  const hasTerms = !!meta.product;
  const params: ProductParams = meta.product ? normalizeParams(meta.product) : {
    productType: 'fcn', name: def.name || 'Custom workflow', issuePricePct: 100,
    underlyings: [], observations: def.fields.filter(f => /^obsDate\d+$/.test(f.name)).length,
  };
  return { params, hasTerms, custom: !!meta.custom || !hasTerms };
}

/** Is a subscription window (a step with `until`) holding a token? */
export const windowOpen = (def: WorkflowDef, s: Pick<NoteState, 'tokens'>) => def.steps.some((st, i) => st.until && s.tokens.includes(i));

export function noteView(def: WorkflowDef, s: NoteState, now = Date.now() / 1000): NoteView {
  const { params, hasTerms, custom } = termsOf(def);
  const num = (name: string) => { const v = fieldOf(def, s, name); return typeof v === 'bigint' ? Number(v) / Number(SCALE) : NaN; };
  const int = (name: string) => { const v = fieldOf(def, s, name); return typeof v === 'bigint' ? Number(v) : 0; };
  const notional = num('notional');
  const strikeDate = int('strikeDate');
  const obsDates = Array.from({ length: params.observations }, (_, k) => int(`obsDate${k + 1}`));

  // One underlying: initialLevel / obsK. A worst-of basket: initialLevel_SYM / obsK_SYM.
  const basket = params.underlyings.length > 1;
  const unds: UnderlyingState[] = params.underlyings.map(u => {
    const strike = fieldOf(def, s, basket ? `initialLevel_${u.symbol}` : 'initialLevel');
    const observed: number[] = [];
    for (let k = 1; k <= params.observations; k++) {
      const v = fieldOf(def, s, basket ? `obs${k}_${u.symbol}` : `obs${k}`);
      if (typeof v !== 'bigint') break;
      observed.push(Number(v) / Number(SCALE));
    }
    return { symbol: u.symbol, feed: u.feed, feedChain: u.feedChain, strike: typeof strike === 'bigint' ? Number(strike) / Number(SCALE) : null, observed };
  });
  const strikeFixed = unds.length > 0 && unds.every(u => u.strike !== null);
  const nObs = unds.length ? Math.min(...unds.map(u => u.observed.length)) : 0;
  const perfs = strikeFixed ? Array.from({ length: nObs }, (_, k) => Math.min(...unds.map(u => u.observed[k] / u.strike!))) : [];

  const issuer = s.roles[0] ?? s.creator;
  const units = (owner: string) => fixed(s.holdings.find(h => h.asset === NOTE_ASSET && h.owner.toLowerCase() === owner.toLowerCase())?.balance);
  const issued = notional > 0 && s.holdings.some(h => h.asset === NOTE_ASSET);
  const issuerUnits = units(issuer);
  const sold = issued ? notional - (Number.isFinite(issuerUnits) ? issuerUnits : 0) : 0;
  const activeSteps = [...new Set(s.tokens.map(t => def.steps[t]?.id).filter(Boolean))] as string[];
  const phase: Phase = s.status === STATUS_COMPLETED ? 'redeemed'
    : windowOpen(def, s) && (strikeDate ? now < strikeDate : true) ? 'book'
    : unds.length && !strikeFixed ? 'fixing' : 'live';

  let outcome: NoteView['outcome'] = null;
  if (!custom && strikeFixed && perfs.length) {
    const path = [...perfs, ...new Array(params.observations - perfs.length).fill(perfs[perfs.length - 1])];
    const r = simulatePerf(params, path);
    outcome = { calledAt: r.calledAt && r.calledAt <= perfs.length ? r.calledAt : undefined, finished: s.status === STATUS_COMPLETED, perUnit: totalPerUnit(r) };
  }
  const label = hasTerms ? (custom ? `Custom ${PRODUCT_LABELS[params.productType]}` : PRODUCT_LABELS[params.productType]) : 'Custom workflow';
  const isin = fieldOf(def, s, 'isin');
  return {
    id: s.id, chain: s.chain, name: params.name || def.name, params, hasTerms, custom, label,
    underlyingText: hasTerms ? underlyingLabel(params) : '—', issuer,
    isin: typeof isin === 'string' ? isin : '', notional: Number.isFinite(notional) ? notional : 0, sold,
    strikeDate, obsDates, unds, strikeFixed, perfs, phase, activeSteps, outcome, reports: s.reports,
    createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

/** A holder's position in one note: units held and cash it can withdraw (both as numbers for display). */
export function positionOf(s: NoteState, owner: string) {
  const bal = (asset: number) => s.holdings.find(h => h.asset === asset && h.owner.toLowerCase() === owner.toLowerCase())?.balance ?? '0';
  return { units: fixed(bal(NOTE_ASSET)), cash: fixed(bal(CASH_ASSET)), cashRaw: BigInt(bal(CASH_ASSET)) };
}

/** One line describing the payoff, from the term sheet. */
export function headline(o: ProductParams) {
  const parts: string[] = [];
  if (o.couponRatePct) parts.push(`${o.couponRatePct}% ${o.productType === 'snowball' ? 'accrued' : 'coupon'} / period`);
  if (o.couponBarrierPct) parts.push(`coupon barrier ${o.couponBarrierPct}%${o.memory ? ' (memory)' : ''}`);
  if (o.autocallLevelPct) parts.push(`autocall ${o.autocallLevelPct}%`);
  if (o.knockInBarrierPct) parts.push(`knock-in ${o.knockInBarrierPct}%`);
  if (o.protectionPct) parts.push(`${o.protectionPct}% protected, ${o.participationPct}% participation`);
  if (o.settlement === 'physical') parts.push('physical delivery');
  return parts.join(' · ');
}

/** History: one line per event, chain-neutral. */
export interface HistoryItem {
  seq: number;
  kind: 'started' | 'step' | 'field' | 'holding' | 'deposit' | 'withdraw' | 'transfer' | 'report' | 'completed' | 'tokens';
  block: number;
  tx: string;
  at: number;
  data: Record<string, unknown>;
}
