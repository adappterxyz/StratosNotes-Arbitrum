/**
 * Engine events, chain-neutral and JSON-safe (bigints as decimal strings), and the reducer that folds them
 * into a NoteState. The indexer stores these events and projects notes with `applyEvent`; replaying a note's
 * events in order rebuilds it exactly (which is how a reorg is undone). State events carry the absolute new
 * value (balance, tokens, field); only the report counters accumulate, so the indexer applies each stored
 * event once (insert-if-new) and rebuilds a note from scratch when it must undo events.
 *
 * EVM events map one to one (evm/decode.ts). A Canton adapter maps its ledger updates to the same events.
 */
import type { FieldValue, NoteState } from './model';
import { noteId } from './model';

export type EngineEvent =
  | { name: 'DefinitionRegistered'; id: string; creator: string; meta: string }
  | { name: 'ProcessStarted'; pid: string; definition: string; creator: string; ref: string; roles: string[]; assetTokens: string[] }
  | { name: 'StepRun'; pid: string; step: number; kind: number; actor: string }
  | { name: 'FieldSet'; pid: string; field: number; value: FieldValue }
  | { name: 'HoldingChanged'; pid: string; asset: number; owner: string; balance: string }
  | { name: 'TokensUpdated'; pid: string; status: number; stepsRun: number; tokens: number[] }
  | { name: 'Deposited'; pid: string; asset: number; account: string; base: string }
  | { name: 'Withdrawn'; pid: string; asset: number; account: string; base: string }
  | { name: 'UnitsTransferred'; pid: string; asset: number; from: string; to: string; amount: string }
  /** `via`: which agent submitted the report, classified when ingested. */
  | { name: 'ReportProcessed'; pid: string; step: number; values: string[]; reporter: string; via: 'cre' | 'fallback' }
  | { name: 'ProcessCompleted'; pid: string }
  | { name: 'FallbackReporterUpdated'; previous: string; next: string };

export type NoteEvent = Extract<EngineEvent, { pid: string }>;

export const hasPid = (e: EngineEvent): e is NoteEvent => 'pid' in e;

export interface EventContext {
  chain: string;
  engine: string;
  /** Block time of the event (unix seconds). */
  at: number;
}

/**
 * Account ids as the read model stores them: EVM addresses lower-case (checksums vary), everything else exactly
 * as given (Canton party ids are case-sensitive).
 */
export const normAccount = (a: string) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a);

/** Fold one event into a note's state. `s` is null before ProcessStarted. Returns the new state (or null). */
export function applyEvent(s: NoteState | null, e: NoteEvent, ctx: EventContext): NoteState | null {
  if (e.name === 'ProcessStarted') {
    return {
      id: noteId(ctx.chain, ctx.engine, e.pid), chain: ctx.chain, engine: ctx.engine.toLowerCase(), pid: e.pid,
      definition: e.definition, creator: normAccount(e.creator), ref: e.ref,
      roles: e.roles.map(normAccount), assetTokens: e.assetTokens.map(normAccount),
      status: 0, tokens: [], stepsRun: 0, values: {}, holdings: [], createdAt: ctx.at, updatedAt: ctx.at,
      reports: { cre: 0, fallback: 0, last: null },
    };
  }
  if (!s) return null; // an event for a process whose start we have not seen (e.g. before the start block)
  const n: NoteState = { ...s, updatedAt: Math.max(s.updatedAt, ctx.at) };
  switch (e.name) {
    case 'FieldSet':
      n.values = { ...s.values, [e.field]: e.value };
      break;
    case 'HoldingChanged': {
      const owner = normAccount(e.owner);
      const rest = s.holdings.filter(h => !(h.asset === e.asset && h.owner === owner));
      n.holdings = e.balance === '0' ? rest : [...rest, { asset: e.asset, owner, balance: e.balance }];
      n.holdings.sort((a, b) => a.asset - b.asset || a.owner.localeCompare(b.owner));
      break;
    }
    case 'TokensUpdated':
      n.status = e.status; n.stepsRun = e.stepsRun; n.tokens = [...e.tokens];
      break;
    case 'ReportProcessed':
      n.reports = { ...s.reports, [e.via]: s.reports[e.via] + 1, last: e.via };
      break;
    case 'ProcessCompleted':
      n.status = 1;
      break;
    default:
      break; // StepRun, deposits, withdrawals and transfers are history; their effects arrive as HoldingChanged
  }
  return n;
}
