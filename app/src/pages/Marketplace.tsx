import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { PRODUCT_LABELS, type ProductType } from '@sn/core';
import { headline, PHASE_LABEL, PHASES, type Phase } from '@sn/sdk';
import { useChains } from '../lib/chains';
import { agentLabel, fmtMoney, fmtPct, nextEvent } from '../lib/format';
import { useNotes } from '../lib/live';

const SYMBOLS = ['ETH', 'BTC', 'SOL', 'HYPE', 'TSLA', 'AAPL', 'NVDA', 'SPY'];

/** Every note on every chain this deployment serves: open books first by default; finished ones on request. */
export default function Marketplace() {
  const nav = useNavigate();
  const { config } = useChains();
  const [phases, setPhases] = useState<Set<Phase>>(new Set(['book', 'fixing', 'live']));
  const [type, setType] = useState<'' | ProductType | 'custom'>('');
  const [und, setUnd] = useState('');
  const [chain, setChain] = useState('');
  const [q, setQ] = useState('');
  const status = phases.has('redeemed') ? (phases.size === 1 ? 'redeemed' : 'all') : 'active';
  const { notes, error } = useNotes({ status, product: type || undefined, underlying: und || undefined, chain: chain || undefined, q: q.trim() || undefined });
  const shown = useMemo(() => (notes ?? []).filter(n => phases.has(n.view.phase)), [notes, phases]);
  const counts = useMemo(() => Object.fromEntries(PHASES.map(p => [p, (notes ?? []).filter(n => n.view.phase === p).length])) as Record<Phase, number>, [notes]);
  const chainName = (k: string) => config.chains.find(c => c.key === k)?.name ?? k;
  const toggle = (p: Phase) => setPhases(s => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n.size ? n : s; });

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Marketplace</h1>
          <p>Structured notes on {config.chains.map(c => c.name).join(' and ')}. Subscribe with {config.chains[0]?.stablecoin.symbol ?? 'USDC'} while a book is open; Chainlink CRE fixes the strike and observes every date, and coupons, autocalls and redemptions settle on-chain.</p>
        </div>
        <Link to="/issue" className="btn primary lg"><Plus className="i" />Issue a note</Link>
      </div>

      <div className="filters" role="group" aria-label="Filters">
        {PHASES.map(p => (
          <button key={p} className={`chip ${phases.has(p) ? 'on' : ''}`} aria-pressed={phases.has(p)} onClick={() => toggle(p)}>
            {PHASE_LABEL[p]} {phases.has(p) && <span className="num dim">{counts[p] ?? 0}</span>}
          </button>
        ))}
        {config.chains.length > 1 && (
          <select aria-label="Network" value={chain} onChange={e => setChain(e.target.value)}>
            <option value="">All networks</option>
            {config.chains.map(c => <option key={c.key} value={c.key}>{c.name}</option>)}
          </select>
        )}
        <select aria-label="Product" value={type} onChange={e => setType(e.target.value as typeof type)}>
          <option value="">All products</option>
          {(Object.keys(PRODUCT_LABELS) as ProductType[]).map(t => <option key={t} value={t}>{PRODUCT_LABELS[t]}</option>)}
          <option value="custom">Custom workflows</option>
        </select>
        <select aria-label="Underlying" value={und} onChange={e => setUnd(e.target.value)}>
          <option value="">All underlyings</option>
          {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input type="search" aria-label="Search" placeholder="Search name or ISIN" value={q} onChange={e => setQ(e.target.value)} />
      </div>

      {error && <div className="notice err" role="alert">Could not load notes: {error}</div>}

      {notes === undefined ? <p className="muted">Loading notes…</p>
        : shown.length === 0 ? (
          <div className="empty">
            <strong>{notes.length ? 'No notes match these filters.' : 'No notes yet.'}</strong>
            <span className="small">{phases.has('redeemed') ? 'Try another product or underlying.' : 'Completed notes are hidden: select Redeemed to include them.'}</span>
            <Link to="/issue" className="btn">Issue a note</Link>
          </div>
        ) : (
          <div className="card scroll-x" style={{ padding: 0 }}>
            <table className="t">
              <thead>
                <tr><th>Note</th><th>Underlying</th><th>Network</th><th>Status</th><th className="r">Size</th><th style={{ minWidth: 140 }}>Subscribed</th><th className="r">Coverage</th><th className="r">Paid / unit</th><th>Next</th></tr>
              </thead>
              <tbody>
                {shown.map(({ id, view: o }) => {
                  const pct = o.notional ? Math.min(100, (o.sold / o.notional) * 100) : 0;
                  const href = `/note/${encodeURIComponent(id)}`;
                  const agent = agentLabel(o);
                  return (
                    <tr key={id} className="link" onClick={() => nav(href)}>
                      <td>
                        <Link to={href} onClick={(e: { stopPropagation: () => void }) => e.stopPropagation()} style={{ color: 'hsl(var(--foreground))', fontWeight: 600 }}>{o.name}</Link>
                        <div className="xs muted">{o.label}{o.hasTerms && !o.custom ? ` · ${headline(o.params)}` : ''}</div>
                      </td>
                      <td>{o.underlyingText}</td>
                      <td className="small">{chainName(o.chain)}{agent && <div className="xs muted">{agent}</div>}</td>
                      <td><span className={`pill ${o.phase}`}><span className="dot" />{PHASE_LABEL[o.phase]}</span></td>
                      <td className="r num">{fmtMoney(o.notional, 0)}</td>
                      <td>
                        <div className="bar"><span style={{ width: `${pct}%` }} /></div>
                        <div className="xs muted num" style={{ marginTop: 3 }}>{fmtMoney(o.sold, 0)} · {pct.toFixed(0)}%</div>
                      </td>
                      <td className="r num" title={o.economics?.ratio !== null && o.economics?.ratio !== undefined ? `Required: ${(o.economics.ratio * 100).toFixed(0)}% of the notional` : undefined}>{o.economics?.coveragePct != null ? fmtPct(o.economics.coveragePct) : o.economics?.ratio != null ? `${(o.economics.ratio * 100).toFixed(0)}% req.` : '—'}</td>
                      <td className="r num">{o.outcome ? o.outcome.perUnit.toFixed(4) : '—'}</td>
                      <td className="small muted">{nextEvent(o)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </main>
  );
}
