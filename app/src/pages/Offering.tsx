import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isAddress } from 'viem';
import { AlertTriangle, ArrowLeft, CheckCircle2, Info, Radio, ShieldCheck } from 'lucide-react';
import { dec, defToBpmn, instantiateProduct, SCALE } from '@sn/core';
import { CASH_ASSET, headline, NOTE_ASSET, noteView, PHASE_LABEL, positionOf } from '@sn/sdk';
import TasksPanel from '../components/TasksPanel';
import EconomicsPanel from '../components/EconomicsPanel';
import HoldersPanel from '../components/HoldersPanel';
import BpmnView from '../components/BpmnView';
import { useVerifiedEmail } from '../components/VerifiedEmail';
import PayoffChart from '../components/PayoffChart';
import { Addr, Steps, When, type StepState } from '../components/ui';
import { plainTerms } from '../lib/plain';
import { useAddress, useChains, useSigner, cashSymbol } from '../lib/chains';
import { agentLabel, errText, fmtDate, fmtMoney, fmtPct, fmtPrice, short } from '../lib/format';
import { useDefinition, useNote, useNow } from '../lib/live';

export default function OfferingPage() {
  const { id: rawId } = useParams();
  const id = rawId ? decodeURIComponent(rawId) : undefined;
  const { note, refresh, updatedAt } = useNote(id);
  const def = useDefinition(note?.state.chain, note?.state.definition);
  const now = useNow(1000);
  const { byKey } = useChains();
  const signer = useSigner();
  const emailGate = useVerifiedEmail(); // a verified email before subscribing
  const me = useAddress();
  // Phases move with the clock (the book closes at the strike date) as well as with the chain.
  const o = useMemo(() => (note && def ? noteView(def, note.state, now) : note?.view), [note, def, Math.floor(now / 5)]); // eslint-disable-line react-hooks/exhaustive-deps
  const [unitsIn, setUnits] = useState<string | null>(null);
  const [xfer, setXfer] = useState({ to: '', units: '' });
  const [busy, setBusy] = useState(false);
  // Subscribing is two transactions (a one-time approval, then the swap): shown as steps.
  const [subStep, setSubStep] = useState<{ approve: StepState; swap: StepState } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; tx?: string } | null>(null);
  // Stock products redraw from their term sheet; custom workflows from the definition.
  const xml = useMemo(() => (!o || !def ? '' : o.custom ? defToBpmn(def) : instantiateProduct(o.params).bpmnXml), [o?.custom, def]); // eslint-disable-line react-hooks/exhaustive-deps

  if (note === undefined) return <main className="page"><p className="muted">Loading the note…</p></main>;
  if (note === null || !o) return <main className="page"><div className="empty"><strong>No note with this id.</strong><Link to="/">Back to the marketplace</Link></div></main>;

  const s = note.state;
  const chain = byKey[s.chain];
  const sym = cashSymbol(chain?.cfg, s.assetTokens?.[1]);
  const explorer = chain?.cfg.explorer;
  const mine = me ? positionOf(s, me, def ?? undefined) : null;
  const isIssuer = !!me && me.toLowerCase() === o.issuer.toLowerCase();
  const remaining = Math.max(0, o.notional - o.sold);
  // Default to a round amount that fits what is left in the book.
  const units = unitsIn ?? String(Math.max(0, Math.min(100, Math.floor(remaining))));
  const cost = (Number(units) || 0) * o.params.issuePricePct / 100;
  const subscribable = !!def && o.phase === 'book' && !o.custom && def.steps.some(x => x.id === 'Task_Subscribe');
  const run = async (what: string, f: () => Promise<{ tx: string[] }>) => {
    setBusy(true); setMsg(null);
    try { const r = await f(); setMsg({ kind: 'ok', text: what, tx: r.tx[r.tx.length - 1] }); refresh(); }
    catch (e) { setMsg({ kind: 'err', text: errText(e) }); }
    finally { setBusy(false); }
  };
  const progress = (t: string) => setMsg({ kind: 'ok', text: `${t}…` });
  const subscribe = () => {
    setSubStep({ approve: 'now', swap: 'todo' });
    const onStep = (t: string) => {
      if (/^Approve/i.test(t)) setSubStep({ approve: 'now', swap: 'todo' });
      else if (/^Subscribe/i.test(t)) setSubStep({ approve: 'done', swap: 'now' });
    };
    return run(`Subscribed ${units} units for ${fmtMoney(cost)} ${sym}. They're in your portfolio.`, async () => {
      try {
        const r = await chain.adapter.subscribe(await signer(s.chain), s.id, dec(units), onStep);
        setSubStep({ approve: 'done', swap: 'done' });
        return r;
      } catch (e) {
        setSubStep(x => (x ? { approve: x.approve === 'now' ? 'err' : x.approve, swap: x.swap === 'now' ? 'err' : x.swap } : x));
        throw e;
      }
    });
  };
  const transfer = () => run(`Transferred ${xfer.units} units.`, async () => {
    if (!isAddress(xfer.to.trim())) throw new Error('Enter the recipient wallet address.');
    return chain.adapter.transferUnits(await signer(s.chain), s.id, xfer.to.trim(), dec(xfer.units), progress);
  });
  const withdraw = (asset: number) => run('Withdrawn to your wallet.', async () => chain.adapter.withdraw(await signer(s.chain), s.id, asset, undefined, progress));
  // Delivered tokens (physical settlement) and collateral received on a default, withdrawable like cash.
  const delivered = mine?.other ?? [];
  // The economics panel runs the issuer's funding, top-up and delivery windows; the generic task list skips them.
  const economicSteps = def ? def.steps.map(x => x.id).filter(x => /^Task_(Fund\d+|TopUp_|FundDelivery_)/.test(x)) : [];

  const basket = o.unds.length > 1;
  const levels = (k: number) => o.unds.map(u => `${u.symbol} ${fmtPrice(u.observed[k])}`).join(' · ');
  const events: Array<{ label: string; when: number; value?: string; state: 'done' | 'now' | 'later' }> = o.hasTerms ? [
    {
      label: 'Book closes, strike fixed', when: o.strikeDate,
      value: o.strikeFixed ? o.unds.map(u => `${basket ? `${u.symbol} ` : ''}${fmtPrice(u.strike!)}`).join(' · ') : undefined,
      state: o.strikeFixed ? 'done' : o.phase === 'fixing' ? 'now' : 'later',
    },
    ...o.obsDates.map((t, k) => ({
      label: k === o.obsDates.length - 1 ? 'Final observation (maturity)' : `Observation ${k + 1}`,
      when: t,
      value: o.perfs[k] !== undefined ? (basket ? `worst ${fmtPct(o.perfs[k])} (${levels(k)})` : `${fmtPrice(o.unds[0].observed[k])} (${fmtPct(o.perfs[k])})`) : undefined,
      state: (o.perfs[k] !== undefined ? 'done' : o.phase === 'live' && k === o.perfs.length ? 'now' : 'later') as 'done' | 'now' | 'later',
      ...((o.phase === 'redeemed' || o.phase === 'defaulted') && o.perfs[k] === undefined ? { value: o.phase === 'defaulted' ? 'not reached: defaulted' : o.outcome?.calledAt ? `not needed: called at ${o.outcome.calledAt}` : 'not observed' } : {}),
    })),
  ] : [];
  const secsAgo = Math.max(0, Math.round(now - updatedAt / 1000));
  const agent = agentLabel(o);

  return (
    <main className="page">
      <Link to="/" className="small row" style={{ gap: 4 }}><ArrowLeft className="i" />Marketplace</Link>
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <span className="label">{o.label} · {o.underlyingText}{o.isin ? ` · ${o.isin}` : ''} · {chain?.cfg.name ?? s.chain}</span>
          <div className="row"><h1>{o.name}</h1><span className={`pill ${o.phase}`} data-phase={o.phase}><span className="dot" />{PHASE_LABEL[o.phase]}</span></div>
          {o.hasTerms && <p className="small muted">{headline(o.params)}</p>}
        </div>
        <div className="stack" style={{ gap: 6, alignItems: 'flex-end' }}>
          <span className="pill plain" title="This page updates when the indexer sees anything happen to the note: a report, a subscription, a transfer.">
            <Radio className="i" style={{ width: 12, height: 12, color: 'hsl(var(--success))' }} />Live · updated {secsAgo < 5 ? 'just now' : `${secsAgo}s ago`}
          </span>
          {agent && <span className="pill plain" data-agent={o.reports.last ?? ''} title="Who submitted this note's price reports: Chainlink CRE through its forwarder, or the fallback keeper where CRE cannot write"><ShieldCheck className="i" style={{ width: 12, height: 12 }} />{agent}</span>}
        </div>
      </div>

      <div className="two note-layout">
        <div className="stack">
          <section className="card">
            <div className="kv">
              <div><span className="label">Size</span><span className="v">{fmtMoney(o.notional, 0)} {sym}</span></div>
              <div><span className="label">Subscribed</span><span className="v" data-sold>{fmtMoney(o.sold, 0)}</span></div>
              <div><span className="label">Issue price</span><span className="v">{o.params.issuePricePct}%</span></div>
              <div><span className="label">Observations</span><span className="v">{o.params.observations}</span></div>
              <div><span className="label">{basket ? 'Worst performance' : 'Performance'}</span><span className="v">{o.perfs.length ? fmtPct(o.perfs[o.perfs.length - 1]) : '—'}</span></div>
              <div><span className="label">Paid so far per unit</span><span className="v" data-per-unit>{o.outcome ? `${o.outcome.perUnit.toFixed(4)} ${sym}` : '—'}</span></div>
            </div>
            {o.unds.length > 0 && (
              <div className="scroll-x">
                <table className="t">
                  <thead><tr><th>Underlying</th><th className="r">Strike</th><th className="r">Last observed</th><th className="r">Performance</th></tr></thead>
                  <tbody>
                    {o.unds.map(u => {
                      const last = u.observed[u.observed.length - 1];
                      return (
                        <tr key={u.symbol}>
                          <td>{u.symbol}/USD <span className="xs dim" title={`Chainlink feed on ${u.feedChain}: ${u.feed}`}>Chainlink</span></td>
                          <td className="r num">{u.strike === null ? '—' : fmtPrice(u.strike)}</td>
                          <td className="r num">{last === undefined ? '—' : fmtPrice(last)}</td>
                          <td className="r num">{last === undefined || u.strike === null ? '—' : fmtPct(last / u.strike)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {events.length > 0 && (
            <section className="card">
              <div className="spread"><h3>Schedule</h3><span className="xs muted">Prices observed by Chainlink CRE · times in your time zone</span></div>
              <div className="timeline">
                {events.map(e => (
                  <div key={e.label} className={`tl ${e.state}`}>
                    <span className="mark" />
                    <span>{e.label}<br /><span className="xs muted"><When t={e.when} /></span></span>
                    <span className="num small" style={{ textAlign: 'right' }}>{e.value ?? (e.state === 'now' ? (now >= e.when ? 'due: waiting for the report' : 'next') : '')}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {xml && (
            <details className="adv">
              <summary>Advanced: the note's workflow diagram</summary>
              <div className="adv-body">
                <p className="xs muted">Every step of this note as it runs on-chain. Highlighted: where it is now.</p>
                <BpmnView xml={xml} active={o.activeSteps} />
              </div>
            </details>
          )}
        </div>

        <aside className="stack">
          {subscribable && (
            <section className="card" data-subscribe>
              <div className="spread"><h2>Subscribe</h2><span className="pill book"><span className="dot" />Open until <When t={o.strikeDate} /></span></div>
              <ul className="terms" aria-label="What you get">
                {plainTerms(o.params, sym, o.economics?.ratio ? Math.round(o.economics.ratio * 100) : undefined).map(t => (
                  <li key={t.text} className={t.kind}>{t.kind === 'good' ? <CheckCircle2 className="i" /> : t.kind === 'risk' ? <AlertTriangle className="i" /> : <Info className="i" />}<span>{t.text}</span></li>
                ))}
              </ul>
              <div className="field">
                <label htmlFor="units">How many units? <span className="muted">(1 unit = 1 {sym} of face · {fmtMoney(remaining, 0)} left)</span></label>
                <input id="units" inputMode="decimal" value={units} onChange={e => setUnits(e.target.value)} />
              </div>
              <div className="youpay">
                <div><span className="label">You pay</span><span className="v">{fmtMoney(cost)} {sym}</span></div>
                <div><span className="label">You receive</span><span className="v">{fmtMoney(Number(units) || 0, 0)} units</span></div>
              </div>
              {Number(units) > remaining && <p className="xs err">Only {fmtMoney(remaining, 0)} units are left.</p>}
              <button className="btn primary lg" disabled={!me || busy || !(Number(units) > 0) || Number(units) > remaining} onClick={() => void emailGate.require(s.chain, subscribe)}>
                {me ? (busy ? 'Confirm in your wallet…' : `Subscribe for ${fmtMoney(cost)} ${sym}`) : 'Connect a wallet to subscribe'}
              </button>
              {subStep && <Steps items={[{ label: `Approve ${sym} (one time)`, state: subStep.approve }, { label: 'Subscribe: pay and receive units in one transaction', state: subStep.swap }]} />}
              <p className="xs muted">Need {sym}? Use <b>Get test tokens</b> in the top bar.</p>
              {emailGate.dialog}
            </section>
          )}

          {def && o.economics && <EconomicsPanel e={o.economics} state={s} def={def} issuer={o.issuer} sym={sym} now={now} onDone={refresh} />}

          {def && <TasksPanel state={s} def={def} onDone={refresh} hide={[...(o.custom ? [] : ['Task_Subscribe']), ...economicSteps]} />}

          {mine && (mine.units > 0 || mine.cash > 0 || delivered.length > 0) && (
            <section className="card" data-position>
              <h3>Your position</h3>
              <div className="kv">
                <div><span className="label">Note units</span><span className="v" data-units>{fmtMoney(mine.units)}</span></div>
                <div><span className="label">{isIssuer ? 'Proceeds to withdraw' : 'Cash to withdraw'}</span><span className="v" data-cash>{fmtMoney(mine.cash)}</span></div>
              </div>
              <button className="btn" disabled={busy || !(mine.cash > 0)} onClick={() => withdraw(CASH_ASSET)}>{isIssuer ? `Withdraw proceeds (${sym})` : `Withdraw ${sym}`}</button>
              {delivered.map(h => {
                const name = h.name.replace(/^Collateral /, '');
                const kind = h.name.startsWith('Collateral ') ? (isIssuer ? 'Collateral released' : 'Collateral received') : 'Delivered';
                return (
                  <div key={h.asset} className="spread small" data-other-asset={h.name}>
                    <span>{kind} <span className="num">{h.amount.toFixed(6)}</span> {name}</span>
                    <button className="btn" disabled={busy} onClick={() => withdraw(h.asset)}>Withdraw {name}</button>
                  </div>
                );
              })}
              {mine.units > 0 && o.phase !== 'redeemed' && o.phase !== 'defaulted' && (
                <div className="stack" style={{ gap: 8, borderTop: '1px solid hsl(var(--border))', paddingTop: 10 }}>
                  <span className="label">Transfer notes</span>
                  <div className="field"><label htmlFor="x-to">To wallet</label><input id="x-to" className="num" value={xfer.to} onChange={e => setXfer({ ...xfer, to: e.target.value })} placeholder="0x…" /></div>
                  <div className="field"><label htmlFor="x-units">Units (up to {fmtMoney(mine.units)})</label><input id="x-units" inputMode="decimal" value={xfer.units} onChange={e => setXfer({ ...xfer, units: e.target.value })} /></div>
                  <button className="btn" disabled={busy || !(Number(xfer.units) > 0) || Number(xfer.units) > mine.units} onClick={transfer}>Transfer</button>
                  <span className="xs muted">In whole or in part. Coupons and the redemption from now on go to whoever holds the units.</span>
                </div>
              )}
            </section>
          )}

          {msg && <div className={`notice ${msg.kind}`} role="status">{msg.text} {msg.tx && explorer && <a href={`${explorer}/tx/${msg.tx}`} target="_blank" rel="noreferrer">View transaction</a>}</div>}

          {def && <HoldersPanel state={s} def={def} explorer={explorer} issuer={o.issuer} />}

          {o.custom && def && (
            <section className="card">
              <h3>Workflow fields</h3>
              <table className="t"><tbody>
                {def.fields.map((f, i) => {
                  const v = s.values[i];
                  const shown = !v ? '—' : v.tag === 1 ? (f.kind === 0 ? (Number(BigInt(v.value)) / Number(SCALE)).toLocaleString() : f.kind === 2 ? new Date(Number(v.value) * 1000).toLocaleString() : v.value) : v.value;
                  return <tr key={f.name}><td>{f.name}</td><td className="r num">{shown}</td></tr>;
                })}
              </tbody></table>
            </section>
          )}

          {!o.custom && (
            <section className="card">
              <h3>Payout per 100 at maturity</h3>
              <PayoffChart params={o.params} />
              <p className="xs muted">Against the final {basket ? 'worst performance' : 'level'}, % of strike, if not called earlier. Dashed lines: barriers.</p>
            </section>
          )}

          <details className="adv">
            <summary>Advanced: contract details</summary>
            <div className="adv-body small">
              <div className="spread"><span className="muted">Network</span><span>{chain?.cfg.name ?? s.chain}</span></div>
              <div className="spread"><span className="muted">Engine · note #</span><span><Addr value={s.engine} href={explorer ? `${explorer}/address/${s.engine}` : undefined} /> · #{s.pid}</span></div>
              <div className="spread"><span className="muted">Workflow definition</span><Addr value={s.definition} /></div>
              <div className="spread"><span className="muted">Issuer</span><Addr value={o.issuer} href={explorer ? `${explorer}/address/${o.issuer}` : undefined} /></div>
              <div className="spread"><span className="muted">Note units held</span><span className="num">{fmtMoney(s.holdings.filter(h => h.asset === NOTE_ASSET).reduce((a, h) => a + Number(BigInt(h.balance)) / Number(SCALE), 0), 0)}</span></div>
            </div>
          </details>
        </aside>
      </div>
    </main>
  );
}
