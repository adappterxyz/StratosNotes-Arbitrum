import type { NoteView } from '@sn/sdk';

export const fmtMoney = (x: number, dp = 2) => (Number.isFinite(x) ? x : 0).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const fmtPrice = (x: number) => x.toLocaleString(undefined, { maximumFractionDigits: 2 });
export const fmtPct = (r: number) => `${(r * 100).toFixed(1)}%`;
export const fmtDate = (t: number) => (t ? new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;

/** What happens next, in a few words. */
export function nextEvent(o: NoteView) {
  const e = o.economics;
  if (o.phase === 'defaulted') return 'Defaulted: collateral to holders';
  if (e?.marginCall) return `Margin call: top-up due ${fmtDate(e.marginCall.deadline)}`;
  if (e?.inGrace) return `Payment ${e.inGrace.period} in grace until ${fmtDate(e.inGrace.deadline)}`;
  if (e?.nextCall) return `Payment ${e.nextCall.period} ${e.nextCall.funded ? 'funded' : 'due'} ${fmtDate(e.nextCall.payDate)}`;
  if (o.phase === 'book') return o.strikeDate ? `Book closes ${fmtDate(o.strikeDate)}` : 'Book open';
  if (o.phase === 'fixing') return 'Waiting for the strike fixing';
  if (o.phase === 'live') {
    const k = o.perfs.length;
    return o.obsDates[k] ? `Observation ${k + 1} ${fmtDate(o.obsDates[k])}` : 'In progress';
  }
  return o.outcome?.calledAt ? `Autocalled at observation ${o.outcome.calledAt}` : 'Matured';
}

/** Who acted as calculation agent on this note so far. */
export function agentLabel(o: Pick<NoteView, 'reports'>) {
  if (!o.reports.cre && !o.reports.fallback) return null;
  if (o.reports.fallback && !o.reports.cre) return 'Fallback keeper';
  if (o.reports.cre && !o.reports.fallback) return 'Reported by Chainlink CRE';
  return `Chainlink CRE (${o.reports.cre}) and fallback keeper (${o.reports.fallback})`;
}

export const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  // viem errors carry long details; the first line says what happened.
  return m.split('\n')[0].replace(/^.*User rejected the request\..*$/i, 'You rejected the request in your wallet.');
};
