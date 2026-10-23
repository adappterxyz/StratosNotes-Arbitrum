import { describe, expect, it } from 'vitest';
import { compile, dec, EXAMPLE_PRODUCTS, instantiateProduct, parseBpmn, reservePerUnit } from '@sn/core';
import { applyEvent, depositAmounts, noteId, noteView, parseNoteId, planIssuance, type NoteEvent, type NoteState } from '../src';

const p = EXAMPLE_PRODUCTS.phoenix;
const prod = instantiateProduct(p);
const ir = parseBpmn(prod.bpmnXml, prod.assets);
const c = compile(ir, { product: prod.params });
const field = (n: string) => c.def.fields.findIndex(f => f.name === n);

describe('note ids', () => {
  it('round-trip and reject junk', () => {
    const id = noteId('arbitrum-sepolia', '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD', 7n);
    expect(id).toBe('arbitrum-sepolia:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:7');
    expect(parseNoteId(id)).toEqual({ chain: 'arbitrum-sepolia', engine: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', pid: '7' });
    expect(parseNoteId('x:y')).toBeNull();
    expect(parseNoteId("evm:0x00'; drop table notes;--:1")).toBeNull();
  });
});

describe('issuance plan', () => {
  it('reads the pre-trade steps, open roles and the reserve deposit from the workflow', () => {
    const plan = planIssuance(ir, c);
    expect(plan.steps.map(s => s.id)).toEqual(['Task_ApproveTerms', 'Task_Mandate']);
    expect(plan.openRoles).toEqual(c.def.roles.map(r => r === 'Investor'));
    expect(plan.dateFields).toEqual(['strikeDate', 'obsDate1', 'obsDate2', 'obsDate3', 'obsDate4']);
    const terms = plan.steps[0];
    const known = new Map<number, bigint>([[field('notional'), dec(1000)], [field('reserve'), dec(1000 * reservePerUnit(p)!)]]);
    const [d] = depositAmounts(c.def, terms, known);
    expect(d.asset).toBe(1);
    expect(d.amount).toBe(dec(100)); // 4 coupons x 2.5% x 1,000
  });
});

describe('events -> note state', () => {
  const ctx = { chain: 'local', engine: '0x00000000000000000000000000000000000000e1', at: 100 };
  const investor = '0x00000000000000000000000000000000000000a1';
  const events: NoteEvent[] = [
    { name: 'ProcessStarted', pid: '1', definition: '0xd1', creator: '0x00000000000000000000000000000000000000b1', ref: '1', roles: ['0x00000000000000000000000000000000000000b1', '0x00000000000000000000000000000000000000b1', '0x0000000000000000000000000000000000000000'], assetTokens: ['0x0000000000000000000000000000000000000000', '0x00000000000000000000000000000000000000c1'] },
    { name: 'FieldSet', pid: '1', field: field('notional'), value: { tag: 1, value: dec(1000).toString() } },
    { name: 'FieldSet', pid: '1', field: field('isin'), value: { tag: 2, value: 'XS123' } },
    { name: 'HoldingChanged', pid: '1', asset: 0, owner: '0x00000000000000000000000000000000000000b1', balance: dec(1000).toString() },
    { name: 'HoldingChanged', pid: '1', asset: 0, owner: '0x00000000000000000000000000000000000000b1', balance: dec(400).toString() },
    { name: 'HoldingChanged', pid: '1', asset: 0, owner: investor, balance: dec(600).toString() },
    { name: 'TokensUpdated', pid: '1', status: 0, stepsRun: 4, tokens: [c.stepIndex.Task_Subscribe] },
    { name: 'ReportProcessed', pid: '1', step: 3, values: ['1'], reporter: '0xf0', via: 'cre' },
  ];
  it('folds events into the read model, and replaying from scratch gives the same state', () => {
    let s: NoteState | null = null;
    for (const e of events) s = applyEvent(s, e, ctx);
    let again: NoteState | null = null;
    for (const e of events) again = applyEvent(again, e, ctx);
    expect(again).toEqual(s);
    const v = noteView(c.def, s!, 50);
    expect(v.isin).toBe('XS123');
    expect(v.notional).toBe(1000);
    expect(v.sold).toBe(600);
    expect(v.phase).toBe('book');
    expect(v.reports).toEqual({ cre: 1, fallback: 0, last: 'cre' });
    expect(s!.holdings.find(h => h.owner === investor)?.balance).toBe(dec(600).toString());
  });
});
