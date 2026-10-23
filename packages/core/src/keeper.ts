/**
 * What the keeper decides, as pure functions: no I/O and no Node APIs. This file is bundled into the CRE
 * workflow's WASM (cre/notes-keeper-evm) and the fallback keeper (services/keeper-fallback), and unit-tested
 * here, so both agents decide exactly the same thing.
 *
 * Input: a running process's state as the engine holds it (definition, BPMN tokens, captured values) and its
 * decoded definition. Output: the reports that are due now. A report either runs one oracle step (a strike
 * fixing or an observation: the keeper reads each capture's price feed) and everything after it, or only
 * advances (STEP_ADVANCE) when a plain timer is due and nothing else would move the note.
 */
import type { WorkflowDef } from './def-types';

const KIND_SERVICE = 3, KIND_CATCH = 7, SRC_ORACLE = 1;

/** Report step that only runs what is due (FlowEngine.STEP_ADVANCE). */
export const STEP_ADVANCE = 0xffff;
/** Report step reserved for cross-chain payout decisions (FlowEngine.STEP_PAYOUT, Phase 5). */
export const PAYOUT_STEP = 0xfffe;
/** FlowEngine.RUNNING. */
export const STATUS_RUNNING = 0;

/** A process as the keeper sees it. `numbers[f]` is field f's value when it holds a number (dates included). */
export interface ProcessState {
  /** Engine-specific process id (EVM: the numeric pid as a decimal string). */
  id: string;
  /** 0x-hex definition id: sha256 of the definition bytes. */
  definition: string;
  status: number;
  /** Step indexes holding a BPMN token (a step may appear more than once). */
  tokens: number[];
  numbers: Array<bigint | undefined>;
}

/** Where a capture's price comes from: a Chainlink feed on a named chain (CRE chain-selector name). */
export interface FeedRef {
  field: string;
  feed: string;
  feedChain: string;
  /** Seconds the feed may go without an update (its heartbeat). */
  staleness: number;
}

export interface DueReport {
  process: string;
  definition: string;
  step: number;
  /** BPMN id of the step, or 'advance'. */
  stepId: string;
  /** One per oracle capture, in capture order (empty for STEP_ADVANCE). */
  feeds: FeedRef[];
}

/** Where each oracle field's feed is, from the definition's metadata (packages/core/src/compile.ts). */
export function oracleFeeds(def: WorkflowDef): Record<string, { feed: string; feedChain?: string; staleness?: number }> {
  try {
    return (JSON.parse(def.meta) as { oracles?: Record<string, { feed: string; feedChain?: string; staleness?: number }> }).oracles ?? {};
  } catch {
    return {};
  }
}

/** When a step's timer fires (unix seconds), or undefined if its date field is not set yet. */
function timerAt(def: WorkflowDef, p: ProcessState, step: number): number | undefined {
  const t = def.steps[step].timer;
  if (!t) return -Infinity;
  if (t.kind === 0) return Number(t.at);
  const v = p.numbers[t.field];
  return v === undefined ? undefined : Number(v);
}

/**
 * The reports due for one process at `nowSec`: each due oracle step once (lowest step first), then at most
 * one STEP_ADVANCE if a token waits on a due timer step that captures nothing from an oracle.
 */
export function dueReports(p: ProcessState, def: WorkflowDef, nowSec: number): DueReport[] {
  if (p.status !== STATUS_RUNNING) return [];
  const oracles = oracleFeeds(def);
  const out: DueReport[] = [];
  let advance = false;
  for (const t of [...new Set(p.tokens)].sort((a, b) => a - b)) {
    const s = def.steps[t];
    if (!s || (s.kind !== KIND_SERVICE && s.kind !== KIND_CATCH)) continue; // tasks and gateways: not the keeper's
    const caps = s.captures.filter(c => c.source === SRC_ORACLE);
    if (!s.timer && !caps.length) continue; // runs by itself
    const at = timerAt(def, p, t);
    if (at === undefined || nowSec < at) continue;
    if (!caps.length) {
      advance = true; // a plain timer: nothing else will move the note
      continue;
    }
    const feeds = caps.map(c => {
      const name = def.fields[c.field].name;
      const o = oracles[name];
      return o ? { field: name, feed: o.feed, feedChain: o.feedChain ?? 'ethereum-mainnet', staleness: o.staleness ?? 3600 } : null;
    });
    if (feeds.some(f => !f)) continue; // a capture with no recorded feed cannot be observed
    out.push({ process: p.id, definition: p.definition, step: t, stepId: s.id, feeds: feeds as FeedRef[] });
  }
  if (advance && !out.length) out.push({ process: p.id, definition: p.definition, step: STEP_ADVANCE, stepId: 'advance', feeds: [] });
  return out;
}

/**
 * Feed overrides by symbol: route an underlying's feed to another source than the one recorded at compile
 * time (e.g. Robinhood Chain mainnet equity feeds, or a chain's own feeds once CRE reads it). Keyed by the
 * recorded feed address (lowercase).
 */
export type FeedRoutes = Record<string, { feed: string; feedChain: string; staleness?: number }>;

export function routeFeed(f: FeedRef, routes: FeedRoutes | undefined): FeedRef {
  const r = routes?.[f.feed.toLowerCase()];
  return r ? { field: f.field, feed: r.feed, feedChain: r.feedChain, staleness: r.staleness ?? f.staleness } : f;
}

/** Chainlink answer (feed decimals) -> engine fixed point (10 decimals). */
export function feedToFixed(answer: bigint, decimals: number): bigint {
  return decimals <= 10 ? answer * 10n ** BigInt(10 - decimals) : answer / 10n ** BigInt(decimals - 10);
}

/**
 * Check a `latestRoundData` answer and convert it: positive, answered, and no older than the feed's
 * heartbeat plus `allowanceSec` (reads at a finalized block lag the chain head).
 */
export function checkRound(
  round: { roundId: bigint; answer: bigint; updatedAt: bigint; answeredInRound: bigint },
  decimals: number, nowSec: number, staleness: number, allowanceSec: number,
): bigint {
  if (round.roundId === 0n || round.answeredInRound < round.roundId) throw new Error('round not answered');
  if (round.answer <= 0n) throw new Error('non-positive answer');
  const age = nowSec - Number(round.updatedAt);
  if (age > staleness + allowanceSec) throw new Error(`stale round (age ${age}s, max ${staleness + allowanceSec}s)`);
  return feedToFixed(round.answer, decimals);
}
