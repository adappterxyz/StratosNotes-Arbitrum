/**
 * Check a finished e2e note against the reference payoff: the strikes and observations are the values the
 * reports actually carried (ReportProcessed), each holder's cash must equal units x the reference payoff per
 * unit, and every report must come from the expected reporter (the forwarder for CRE, or the fallback).
 *
 *   RPC=... CHAIN_ID=421614 NOTE_JSON=/tmp/note.json EXPECT_REPORTER=0x... npx tsx scripts/e2e/verify.ts
 *   STATUS_ONLY=1 ... prints the process status (0 running, 1 completed) and exits.
 */
import { readFileSync } from 'node:fs';
import type { Address } from 'viem';
import { simulateWorstOf, totalPerUnit } from '@sn/core';
import { engineAbi } from '@sn/sdk';
import { clients, compiled, NOTE } from './lib';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`set ${k}`); return v; };
const note = JSON.parse(readFileSync(env('NOTE_JSON'), 'utf8')) as {
  pid: string; engine: Address; fromBlock: string; investors: Array<{ address: Address; units: number }>; pa: Address;
};
const { client } = clients(env('RPC'), Number(env('CHAIN_ID')));
const pid = BigInt(note.pid);
const proc = await client.readContract({ address: note.engine, abi: engineAbi, functionName: 'processOf', args: [pid] });
if (process.env.STATUS_ONLY) { console.log(proc.status); process.exit(0); }

const { c } = compiled();
const logs = await client.getContractEvents({ address: note.engine, abi: engineAbi, eventName: 'ReportProcessed', args: { pid }, fromBlock: BigInt(note.fromBlock) });
const byStep = new Map<number, bigint[]>();
const lines: string[] = [];
let ok = true;
const expectReporter = env('EXPECT_REPORTER').toLowerCase();
for (const l of logs) {
  const { step, values, reporter } = l.args as { step: number; values: readonly bigint[]; reporter: Address };
  const receipt = await client.getTransactionReceipt({ hash: l.transactionHash });
  const name = c.def.steps[step]?.id ?? (step === 0xffff ? 'advance' : String(step));
  lines.push(`report ${name} [${values.map(v => (Number(v) / 1e10).toFixed(2)).join(', ')}] by ${reporter} in ${l.transactionHash} (tx gas ${receipt.gasUsed})`);
  if (reporter.toLowerCase() !== expectReporter) { ok = false; lines.push(`  ! expected reporter ${expectReporter}`); }
  byStep.set(step, [...values]);
}
const strikes = byStep.get(c.stepIndex.Task_FixStrike)!.map(v => Number(v) / 1e10);
const rows: number[][] = [];
for (let k = 1; k <= NOTE.observations; k++) {
  const v = byStep.get(c.stepIndex[`Task_Observe${k}`]);
  rows.push(v ? v.map(x => Number(x) / 1e10) : strikes.map(() => 0)); // not observed: autocalled before
}
const ref = simulateWorstOf(NOTE, strikes, rows);
const perUnit = totalPerUnit(ref);
lines.push(`reference: coupons [${ref.coupons.join(', ')}], ${ref.calledAt ? `called at ${ref.calledAt}` : 'to maturity'}, redemption ${ref.redemptionCash} -> ${perUnit} per unit`);
if (proc.status !== 1) { ok = false; lines.push(`! process status ${proc.status}, expected completed (1)`); }
for (const inv of note.investors) {
  const cash = await client.readContract({ address: note.engine, abi: engineAbi, functionName: 'balanceOf', args: [pid, inv.address, 1n] });
  const want = inv.units * perUnit;
  const got = Number(cash) / 1e10;
  const good = Math.abs(got - want) <= inv.units * 5e-7;
  if (!good) ok = false;
  lines.push(`${inv.address} ${inv.units} units: paid ${got} USDC, reference ${want} -> ${good ? 'match' : 'MISMATCH'}`);
}
console.log(lines.join('\n'));
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
