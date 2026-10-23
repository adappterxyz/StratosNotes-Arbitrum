/**
 * EvmAdapter: ChainAdapter for FlowEngine (packages/evm-engine) with viem. Writes take a viem WalletClient
 * (the app's connected wallet, a service key, or a test account); reads use a PublicClient.
 */
import { sha256 } from '@noble/hashes/sha256';
import {
  erc20Abi, numberToHex, parseEventLogs, zeroAddress, type Address, type Hex, type PublicClient, type WalletClient,
} from 'viem';
import { decodeEvmDef, evmInput, toBase, type EvmInput, type WorkflowDef } from '@sn/core';
import type { ChainAdapter, IssueRequest, Progress, Submitted } from '../adapter';
import { applyEvent, hasPid, type EngineEvent } from '../events';
import { depositAmounts, type InputValue, type PlanStep } from '../issue';
import { isBookStep, noteId, parseNoteId, type ChainInfo, type FieldValue, type NoteId, type NoteState } from '../model';
import { decodeEngineLog, fieldValue } from './decode';
import { flowEngineAbi, notesLensAbi } from './generated';
import { bytesToHex, hexToBytes, tagOf } from './state';

const NO_CHOICE = 0xffff;
const KIND_USER = 2;

export interface EvmDeployment {
  engine: Address;
  lens: Address;
  /** Block the engine was deployed at: where event scans start. */
  fromBlock?: bigint;
}

export function toEvmInput(v: InputValue): EvmInput {
  return v.kind === 'number' ? evmInput.number(v.value) : v.kind === 'text' ? evmInput.text(v.value) : evmInput.party(v.value);
}

const numberOf = (v: FieldValue | undefined) => (v && v.tag === 1 ? BigInt(v.value) : null);

export class EvmAdapter implements ChainAdapter<WalletClient> {
  private defs = new Map<string, Promise<WorkflowDef | null>>();

  constructor(readonly chain: ChainInfo, readonly client: PublicClient, readonly dep: EvmDeployment) {}

  private pidOf(id: NoteId): bigint {
    const p = parseNoteId(id);
    if (!p || p.chain !== this.chain.key || p.engine !== this.dep.engine.toLowerCase()) throw new Error(`not a note on ${this.chain.key} engine ${this.dep.engine}: ${id}`);
    return BigInt(p.pid);
  }

  private async send(w: WalletClient, req: { address: Address; abi: unknown; functionName: string; args: unknown[] }, label: string, onProgress?: Progress) {
    onProgress?.(label);
    const account = w.account;
    if (!account) throw new Error('The wallet has no account connected.');
    // Gas with headroom: a step's cost depends on the block it lands in (timers and windows read the block time),
    // so the estimate made a block earlier can be just short. An exact estimate ran out of gas in the e2e.
    const est = await this.client.estimateContractGas({ ...req, account } as never);
    const gas = (est * 125n) / 100n + 30_000n;
    const hash = await w.writeContract({ ...req, account, chain: w.chain, gas } as never);
    const r = await this.client.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${label}: the transaction reverted (${hash}).`);
    return r;
  }

  // ---- reads ----------------------------------------------------------------------------------------------

  getDefinition(id: string): Promise<WorkflowDef | null> {
    const key = id.toLowerCase();
    if (!this.defs.has(key)) {
      this.defs.set(key, (async () => {
        const data = await this.client.readContract({ address: this.dep.lens, abi: notesLensAbi, functionName: 'definitionBytes', args: [key as Hex] });
        return data === '0x' ? null : decodeEvmDef(hexToBytes(data));
      })().catch(e => { this.defs.delete(key); throw e; }));
    }
    return this.defs.get(key)!;
  }

  async getNote(id: NoteId): Promise<NoteState | null> {
    const pid = this.pidOf(id);
    const e = { address: this.dep.engine, abi: flowEngineAbi } as const;
    const proc = await this.client.readContract({ ...e, functionName: 'processOf', args: [pid] });
    if (proc.definition === `0x${'0'.repeat(64)}`) return null;
    const def = await this.getDefinition(proc.definition);
    if (!def) return null;
    const [tokens, holders] = await Promise.all([
      this.client.readContract({ ...e, functionName: 'tokensOf', args: [pid] }),
      this.client.readContract({ ...e, functionName: 'holdersOf', args: [pid] }),
    ]);
    const roles = await Promise.all(def.roles.map((_, i) => this.client.readContract({ ...e, functionName: 'roleOf', args: [pid, BigInt(i)] })));
    const assetTokens = await Promise.all(def.assets.map((_, i) => this.client.readContract({ ...e, functionName: 'assetTokenOf', args: [pid, BigInt(i)] })));
    const values: NoteState['values'] = {};
    await Promise.all(def.fields.map(async (_, f) => {
      if (tagOf(BigInt(proc.tags), f) === 0) return;
      const [tag, data] = await this.client.readContract({ ...e, functionName: 'valueOf', args: [pid, BigInt(f)] });
      values[f] = fieldValue(tag, data);
    }));
    const holdings: NoteState['holdings'] = [];
    for (const owner of holders) {
      for (let a = 0; a < def.assets.length; a++) {
        const b = await this.client.readContract({ ...e, functionName: 'balanceOf', args: [pid, owner, BigInt(a)] });
        if (b !== 0n) holdings.push({ asset: a, owner: owner.toLowerCase(), balance: b.toString() });
      }
    }
    const fallback = (await this.client.readContract({ ...e, functionName: 'fallbackReporter' })).toLowerCase();
    const reports = await this.client.getContractEvents({ ...e, eventName: 'ReportProcessed', args: { pid }, fromBlock: this.dep.fromBlock ?? 0n });
    // Economic milestones (payment made, missed, defaulted, ...): the payment schedule's status reads them.
    const marks = await this.client.getContractEvents({ ...e, eventName: 'Milestone', args: { pid }, fromBlock: this.dep.fromBlock ?? 0n });
    const blockTime = new Map<bigint, number>();
    for (const m of marks) if (!blockTime.has(m.blockNumber)) blockTime.set(m.blockNumber, Number((await this.client.getBlock({ blockNumber: m.blockNumber })).timestamp));
    const milestones = marks.map(m => ({ code: Number(m.args.code), step: Number(m.args.step), at: blockTime.get(m.blockNumber) ?? 0 }));
    const via = reports.map(r => ((r.args.reporter ?? '').toLowerCase() === fallback && fallback !== zeroAddress ? 'fallback' : 'cre') as 'cre' | 'fallback');
    return {
      id: noteId(this.chain.key, this.dep.engine, pid), chain: this.chain.key, engine: this.dep.engine.toLowerCase(), pid: pid.toString(),
      definition: proc.definition.toLowerCase(), creator: proc.creator.toLowerCase(), ref: proc.ref.toString(),
      roles: roles.map(r => r.toLowerCase()), assetTokens: assetTokens.map(a => a.toLowerCase()),
      status: proc.status, tokens: [...tokens], stepsRun: proc.stepsRun, values,
      holdings: holdings.sort((a, b) => a.asset - b.asset || a.owner.localeCompare(b.owner)),
      createdAt: Number(proc.createdAt), updatedAt: Number(proc.updatedAt),
      reports: { cre: via.filter(v => v === 'cre').length, fallback: via.filter(v => v === 'fallback').length, last: via[via.length - 1] ?? null },
      milestones,
    };
  }

  async listNotes(): Promise<NoteState[]> {
    const n = await this.client.readContract({ address: this.dep.engine, abi: flowEngineAbi, functionName: 'processCount' });
    const out: NoteState[] = [];
    for (let pid = 1n; pid <= n; pid++) {
      const s = await this.getNote(noteId(this.chain.key, this.dep.engine, pid));
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async history(id: NoteId) {
    const pid = this.pidOf(id);
    // Every note event has the pid as its first indexed topic.
    const pidTopic = `0x${pid.toString(16).padStart(64, '0')}` as Hex;
    const raw = await this.client.request({
      method: 'eth_getLogs',
      params: [{ address: this.dep.engine, fromBlock: numberToHex(this.dep.fromBlock ?? 0n), toBlock: 'latest', topics: [null, pidTopic] }],
    } as never) as Array<{ data: Hex; topics: Hex[]; blockNumber: Hex; transactionHash: Hex }>;
    const logs = raw.map(l => ({ ...l, blockNumber: BigInt(l.blockNumber) }));
    const fallback = (await this.client.readContract({ address: this.dep.engine, abi: flowEngineAbi, functionName: 'fallbackReporter' })).toLowerCase();
    const out: Array<{ block: number; tx: string; event: EngineEvent }> = [];
    for (const l of logs) {
      const ev = decodeEngineLog(l, r => r === fallback && fallback !== zeroAddress);
      if (ev && hasPid(ev)) out.push({ block: Number(l.blockNumber), tx: l.transactionHash, event: ev });
    }
    return out;
  }

  /** Rebuild a note from its events (what the indexer does), e.g. to check the indexer against the chain. */
  async noteFromEvents(id: NoteId): Promise<NoteState | null> {
    let s: NoteState | null = null;
    for (const h of await this.history(id)) {
      const block = await this.client.getBlock({ blockNumber: BigInt(h.block) });
      if (hasPid(h.event)) s = applyEvent(s, h.event, { chain: this.chain.key, engine: this.dep.engine, at: Number(block.timestamp) });
    }
    return s;
  }

  // ---- writes ---------------------------------------------------------------------------------------------

  private async ensureAllowance(w: WalletClient, token: Address, amount: bigint, onProgress?: Progress) {
    if (amount <= 0n) return [];
    const owner = w.account!.address;
    const have = await this.client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, this.dep.engine] });
    if (have >= amount) return [];
    const r = await this.send(w, { address: token, abi: erc20Abi, functionName: 'approve', args: [this.dep.engine, amount] }, 'Approve the stablecoin', onProgress);
    return [r.transactionHash];
  }

  async registerDefinition(w: WalletClient, bytes: Uint8Array, onProgress?: Progress) {
    const data = bytesToHex(bytes);
    const tx: string[] = [];
    const id = bytesToHex(sha256(bytes));
    const [pointer] = await this.client.readContract({ address: this.dep.engine, abi: flowEngineAbi, functionName: 'definitionOf', args: [id] });
    if (pointer === zeroAddress) tx.push((await this.send(w, { address: this.dep.engine, abi: flowEngineAbi, functionName: 'registerDefinition', args: [data] }, 'Publish the workflow', onProgress)).transactionHash);
    // Keepers (CRE, fallback) read the full definition, oracle feeds included, from the lens.
    const published = await this.client.readContract({ address: this.dep.lens, abi: notesLensAbi, functionName: 'isPublished', args: [id] });
    if (!published) tx.push((await this.send(w, { address: this.dep.lens, abi: notesLensAbi, functionName: 'publish', args: [data] }, 'Publish the workflow for the keepers', onProgress)).transactionHash);
    return { tx, definition: id };
  }

  /** Run one plan step's deposits' approvals and the step itself. */
  private async runStep(w: WalletClient, def: WorkflowDef, pid: bigint | null, step: PlanStep, inputs: Record<number, InputValue>, known: Map<number, bigint>, tokens: Record<number, string>, onProgress?: Progress) {
    for (const i of step.inputs) {
      const v = inputs[i.field];
      if (!v) throw new Error(`${step.name}: ${i.name} is required.`);
      if (v.kind === 'number') known.set(i.field, v.value);
    }
    const tx: string[] = [];
    const need = new Map<number, bigint>();
    for (const d of depositAmounts(def, step, known)) {
      if (d.amount === null) throw new Error(`${step.name}: cannot work out the deposit amount yet.`);
      need.set(d.asset, (need.get(d.asset) ?? 0n) + toBase(d.amount, def.assets[d.asset].decimals));
    }
    for (const [asset, base] of need) {
      const token = tokens[asset];
      if (!token || token === zeroAddress) throw new Error(`${step.name}: no token configured for ${def.assets[asset].name}.`);
      tx.push(...await this.ensureAllowance(w, token as Address, base, onProgress));
    }
    return { tx, args: step.inputs.map(i => toEvmInput(inputs[i.field])), pid };
  }

  async issue(w: WalletClient, req: IssueRequest, onProgress?: Progress) {
    const issuer = w.account?.address;
    if (!issuer) throw new Error('Connect a wallet to issue.');
    const tx: string[] = [];
    const reg = await this.registerDefinition(w, req.definition, onProgress);
    tx.push(...reg.tx);
    // Open roles (the book) are anyone's and escrow is the engine's: both are address 0 at the start.
    const roles = req.plan.openRoles.map((open, i) => (open || req.plan.escrowRoles?.[i] ? zeroAddress : issuer));
    const assetTokens = req.def.assets.map((a, i) => (a.kind === 1 ? (req.cashTokens[i] ?? zeroAddress) : zeroAddress)) as Address[];
    const known = new Map<number, bigint>();
    const start = await this.runStep(w, req.def, null, req.plan.start, req.inputs[req.plan.start.index] ?? {}, known, req.cashTokens, onProgress);
    tx.push(...start.tx);
    const started = await this.send(w, {
      address: this.dep.engine, abi: flowEngineAbi, functionName: 'startProcess',
      args: [reg.definition, req.ref, roles, assetTokens, req.plan.start.index, start.args],
    }, 'Start the issuance', onProgress);
    tx.push(started.transactionHash);
    const ev = parseEventLogs({ abi: flowEngineAbi, logs: started.logs, eventName: 'ProcessStarted' })[0];
    if (!ev) throw new Error('The engine did not report the new issuance.');
    const pid = ev.args.pid;
    for (const step of req.plan.steps) {
      const r = await this.runStep(w, req.def, pid, step, req.inputs[step.index] ?? {}, known, req.cashTokens, onProgress);
      tx.push(...r.tx);
      tx.push((await this.send(w, {
        address: this.dep.engine, abi: flowEngineAbi, functionName: 'executeStep', args: [pid, step.index, NO_CHOICE, r.args],
      }, step.name, onProgress)).transactionHash);
    }
    return { tx, id: noteId(this.chain.key, this.dep.engine, pid) };
  }

  /** The open subscription step holding a token now (a user task with a repeatable window and a deposit). */
  static subscribeStep(def: WorkflowDef, s: Pick<NoteState, 'tokens' | 'roles'>): number {
    const i = def.steps.findIndex((st, k) => st.kind === KIND_USER && isBookStep(def, s, k) && st.ops.some(o => o.kind === 5));
    if (i < 0) throw new Error('This note is not taking subscriptions now.');
    return i;
  }

  async subscribe(w: WalletClient, id: NoteId, units: bigint, onProgress?: Progress): Promise<Submitted> {
    const s = await this.getNote(id);
    if (!s) throw new Error('No such note.');
    const def = (await this.getDefinition(s.definition))!;
    const stepIdx = EvmAdapter.subscribeStep(def, s);
    const st = def.steps[stepIdx];
    const inputs = st.captures.filter(c => c.source === 0);
    if (inputs.length !== 1) throw new Error('The subscription step takes one input (units).');
    const known = new Map<number, bigint>();
    for (const [f, v] of Object.entries(s.values)) { const n = numberOf(v); if (n !== null) known.set(Number(f), n); }
    known.set(inputs[0].field, units);
    const step: PlanStep = { id: st.id, name: 'Subscribe', index: stepIdx, inputs: [{ field: inputs[0].field, name: def.fields[inputs[0].field].name, kind: def.fields[inputs[0].field].kind }], deposits: st.ops.filter(o => o.kind === 5).map(o => ({ asset: o.asset, amountExpr: o.amount })) };
    const tokens = Object.fromEntries(s.assetTokens.map((t, i) => [i, t]));
    const r = await this.runStep(w, def, BigInt(s.pid), step, { [inputs[0].field]: { kind: 'number', value: units } }, known, tokens, onProgress);
    const sent = await this.send(w, { address: this.dep.engine, abi: flowEngineAbi, functionName: 'executeStep', args: [BigInt(s.pid), stepIdx, NO_CHOICE, r.args] }, 'Subscribe', onProgress);
    return { tx: [...r.tx, sent.transactionHash] };
  }

  async executeStep(w: WalletClient, id: NoteId, stepIdx: number, inputs: Record<number, InputValue>, choice?: number, onProgress?: Progress): Promise<Submitted> {
    const s = await this.getNote(id);
    if (!s) throw new Error('No such note.');
    const def = (await this.getDefinition(s.definition))!;
    const st = def.steps[stepIdx];
    if (!st) throw new Error('No such step.');
    const known = new Map<number, bigint>();
    for (const [f, v] of Object.entries(s.values)) { const n = numberOf(v); if (n !== null) known.set(Number(f), n); }
    const step: PlanStep = {
      id: st.id, name: st.id, index: stepIdx,
      inputs: st.captures.filter(c => c.source === 0).map(c => ({ field: c.field, name: def.fields[c.field].name, kind: def.fields[c.field].kind })),
      deposits: st.ops.filter(o => o.kind === 5).map(o => ({ asset: o.asset, amountExpr: o.amount })),
    };
    const tokens = Object.fromEntries(s.assetTokens.map((t, i) => [i, t]));
    const r = await this.runStep(w, def, BigInt(s.pid), step, inputs, known, tokens, onProgress);
    const sent = await this.send(w, {
      address: this.dep.engine, abi: flowEngineAbi, functionName: 'executeStep', args: [BigInt(s.pid), stepIdx, choice ?? NO_CHOICE, r.args],
    }, st.id, onProgress);
    return { tx: [...r.tx, sent.transactionHash] };
  }

  async transferUnits(w: WalletClient, id: NoteId, to: string, units: bigint, onProgress?: Progress): Promise<Submitted> {
    const pid = this.pidOf(id);
    const r = await this.send(w, { address: this.dep.engine, abi: flowEngineAbi, functionName: 'transferUnits', args: [pid, 0, to as Address, units] }, 'Transfer units', onProgress);
    return { tx: [r.transactionHash] };
  }

  async withdraw(w: WalletClient, id: NoteId, asset: number, amount?: bigint, onProgress?: Progress): Promise<Submitted> {
    const pid = this.pidOf(id);
    const owner = w.account?.address;
    if (!owner) throw new Error('Connect a wallet to withdraw.');
    const s = await this.client.readContract({ address: this.dep.engine, abi: flowEngineAbi, functionName: 'processOf', args: [pid] });
    const def = (await this.getDefinition(s.definition))!;
    const held = await this.client.readContract({ address: this.dep.engine, abi: flowEngineAbi, functionName: 'balanceOf', args: [pid, owner, BigInt(asset)] });
    const fixed = amount ?? held;
    if (fixed <= 0n || fixed > held) throw new Error('Nothing to withdraw.');
    const base = toBase(fixed, def.assets[asset].decimals);
    const r = await this.send(w, { address: this.dep.engine, abi: flowEngineAbi, functionName: 'withdraw', args: [pid, asset, base] }, 'Withdraw', onProgress);
    return { tx: [r.transactionHash] };
  }
}
