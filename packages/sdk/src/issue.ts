/**
 * How to issue a workflow, read from the workflow itself, so it works for stock products and custom notes
 * alike (ported from the hackathon app):
 *  - roles: a pool with a repeatable window (the subscription book) is OPEN to anyone; every other pool is held
 *    by the issuer;
 *  - the issuer starts at the start event of a pool it holds (Issuer first);
 *  - the pre-trade steps are the user tasks that follow that start event in the same pool (a product's Approve
 *    Terms and Mandate Paying Agent, physical delivery reserves). Their input fields become the issue form, and
 *    a step that deposits cash pulls it from the issuer's wallet.
 */
import { evalExpr, FKIND, OP, SRC, type Compiled, type WorkflowDef, type WorkflowIR } from '@sn/core';

export interface PlanInput { field: number; name: string; kind: number }
export interface PlanStep {
  id: string;
  name: string;
  index: number;
  inputs: PlanInput[];
  /** Cash assets this step pulls from the signer (DEPOSIT ops), with each op's amount expression. */
  deposits: Array<{ asset: number; amountExpr: number }>;
}
export interface IssuePlan {
  start: PlanStep;
  /** User tasks run right after the start, in order. */
  steps: PlanStep[];
  openPools: string[];
  heldPools: string[];
  /** Per role: true when anyone may act in it (the investors' book). */
  openRoles: boolean[];
  cashAssets: number[];
  /** Product-shaped schedule: a strike date and observation dates. */
  dateFields: string[];
}

export function planIssuance(ir: WorkflowIR, c: Compiled): IssuePlan {
  const open = new Set(ir.nodes.filter(n => n.props.until).map(n => n.pool));
  const starts = ir.nodes.filter(n => n.type === 'startEvent' && !open.has(n.pool));
  const poolName = (id: string) => ir.pools.find(p => p.id === id)?.name ?? id;
  const start = starts.find(n => /issuer/i.test(poolName(n.pool))) ?? starts[0];
  if (!start) throw new Error('The workflow needs a start event in a pool the issuer holds (one without a subscription window).');
  const step = (id: string): PlanStep => {
    const index = c.stepIndex[id];
    const s = c.def.steps[index];
    const node = ir.nodes.find(n => n.id === id)!;
    return {
      id, name: node.name || id, index,
      inputs: s.captures.filter(x => x.source === SRC.INPUT).map(x => ({ field: x.field, name: c.def.fields[x.field].name, kind: c.def.fields[x.field].kind })),
      deposits: s.ops.filter(o => o.kind === OP.DEPOSIT).map(o => ({ asset: o.asset, amountExpr: o.amount })),
    };
  };
  const steps: PlanStep[] = [];
  const flowsFrom = (id: string) => ir.flows.filter(f => f.source === id);
  let at: string | undefined = flowsFrom(start.id)[0]?.target;
  const seen = new Set<string>();
  while (at && !seen.has(at)) {
    seen.add(at);
    const n = ir.nodes.find(x => x.id === at);
    if (!n || n.type !== 'userTask' || n.pool !== start.pool) break;
    steps.push(step(n.id));
    const out = flowsFrom(n.id);
    at = out.length === 1 ? out[0].target : undefined;
  }
  const all = [step(start.id), ...steps].flatMap(s => s.inputs);
  // Roles are the pools, in pool order (compile.ts).
  return {
    start: step(start.id), steps,
    openPools: ir.pools.filter(p => open.has(p.id)).map(p => p.name), heldPools: ir.pools.filter(p => !open.has(p.id)).map(p => p.name),
    openRoles: ir.pools.map(p => open.has(p.id)),
    cashAssets: ir.assets.map((a, i) => (a.kind === 'cash' ? i : -1)).filter(i => i >= 0),
    dateFields: all.filter(f => f.kind === FKIND.Date && /^(strikeDate|obsDate\d+)$/.test(f.name)).map(f => f.name),
  };
}

/** A typed input value: numbers in engine form (fixed point for decimals, plain for dates/ints), text, a party. */
export type InputValue = { kind: 'number'; value: bigint } | { kind: 'text'; value: string } | { kind: 'party'; value: string };

/**
 * The amounts (engine fixed point) a step's deposits will pull, given every field value known by then
 * (`known`, by field index: earlier steps' inputs plus this step's own). Null for an amount that cannot be
 * computed yet (a field it reads is unset).
 */
export function depositAmounts(def: WorkflowDef, step: PlanStep, known: Map<number, bigint>): Array<{ asset: number; amount: bigint | null }> {
  const kinds = def.fields.map(f => f.kind);
  return step.deposits.map(d => ({ asset: d.asset, amount: evalExpr(def.exprs[d.amountExpr], kinds, f => known.get(f) ?? null) }));
}

/** "obsDate3" -> 3; strikeDate -> 0. */
export const obsIndex = (name: string) => (name === 'strikeDate' ? 0 : Number(name.replace('obsDate', '')));

export const FIELD_LABEL: Record<string, string> = {
  isin: 'ISIN / reference', notional: 'Size (units of 1 USDC)', strikeDate: 'Strike date (book closes)', reserve: 'Coupon reserve (USDC)', units: 'Units',
};
