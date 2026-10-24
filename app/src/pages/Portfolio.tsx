/**
 * The portfolio, by category: wallet assets on each chain, notes you subscribed to, notes you issued, collateral
 * and receipts, and payouts waiting to be withdrawn. Every note row opens that note's current state.
 * `?address=0x…` shows any wallet read-only (no actions), e.g. to look at a demo investor.
 */
import { cashSymbol } from '../lib/chains';
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { isAddress } from 'viem';
import { Coins, FileText, Landmark, Lock, RefreshCw, Wallet } from 'lucide-react';
import { CASH_ASSET, type NoteView } from '@sn/sdk';
import { useAddress, useChains, useSigner } from '../lib/chains';
import { errText, fmtMoney, fmtPct, nextEvent } from '../lib/format';
import { useNotes, usePortfolio } from '../lib/live';
import { useWalletBalances } from '../lib/balances';
import { RedeemOnRobinhood } from '../components/CrossChainCollateral';
import { Asset, AssetStack } from '../components/AssetIcon';
import { StatePill, currentState } from '../components/NoteState';
import { Addr } from '../components/ui';

type Tab = 'wallet' | 'subscribed' | 'issued' | 'collateral' | 'withdraw';

const symsOf = (o: NoteView) => (o.unds.length ? o.unds.map(u => u.symbol) : o.params.underlyings.map(u => u.symbol));

export default function Portfolio() {
  const connected = useAddress();
  const [params] = useSearchParams();
  const override = params.get('address');
  const address = override && isAddress(override) ? override.toLowerCase() : connected;
  const readOnly = !!address && address !== connected;
  const nav = useNavigate();
  const { byKey } = useChains();
  const signer = useSigner();
  const { positions, refresh } = usePortfolio(address ?? undefined);
  const { notes } = useNotes({ status: 'all' });
  const { data: wallet, refresh: refreshWallet } = useWalletBalances(address);
  const [tab, setTab] = useState<Tab>('subscribed');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; tx?: string; explorer?: string } | null>(null);

  const subscribed = useMemo(() => (positions ?? []).filter(p => p.position.units > 0 && p.view.issuer.toLowerCase() !== address), [positions, address]);
  const issued = useMemo(() => (notes ?? []).filter(n => n.view.issuer.toLowerCase() === address), [notes, address]);
  const withdrawable = useMemo(() => (positions ?? []).filter(p => p.position.cash > 0 || p.position.holdings.some(h => h.asset > CASH_ASSET && BigInt(h.balance) > 0n)), [positions]);
  const due = issued.filter(n => currentState(n.view).key === 'due' || currentState(n.view).key === 'grace' || currentState(n.view).key === 'margin');

  if (!address) {
    return (
      <main className="page">
        <div className="empty">
          <strong>Connect a wallet to see your portfolio.</strong>
          <span className="small">Your assets on Arbitrum and Robinhood Chain, the notes you hold or issued, and what you can withdraw.</span>
          <Link to="/" className="btn">Browse notes</Link>
        </div>
      </main>
    );
  }

  const open = (id: string) => nav(`/note/${encodeURIComponent(id)}`);
  const rowProps = (id: string, name: string) => ({
    className: 'link', tabIndex: 0, role: 'link', 'aria-label': `Open ${name}`,
    onClick: () => open(id),
    onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(id); } },
  });

  const withdraw = async (id: string, chain: string, name: string, cash: number) => {
    setBusy(id); setMsg(null);
    try {
      const w = await signer(chain);
      const r = await byKey[chain].adapter.withdraw(w, id, CASH_ASSET);
      setMsg({ kind: 'ok', text: `Withdrew ${fmtMoney(cash)} ${byKey[chain].cfg.stablecoin.symbol} from ${name}.`, tx: r.tx[r.tx.length - 1], explorer: byKey[chain].cfg.explorer });
      refresh(); refreshWallet();
    } catch (e) { setMsg({ kind: 'err', text: errText(e) }); }
    finally { setBusy(''); }
  };

  const tabs: Array<{ id: Tab; label: string; icon: ReactNode; n?: number; flag?: boolean }> = [
    { id: 'subscribed', label: 'Subscribed notes', icon: <FileText className="i" />, n: subscribed.length },
    { id: 'issued', label: 'Issued notes', icon: <Landmark className="i" />, n: issued.length, flag: due.length > 0 },
    { id: 'withdraw', label: 'To withdraw', icon: <Coins className="i" />, n: withdrawable.length, flag: withdrawable.length > 0 },
    { id: 'collateral', label: 'Collateral & receipts', icon: <Lock className="i" /> },
    { id: 'wallet', label: 'Wallet assets', icon: <Wallet className="i" /> },
  ];

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Portfolio</h1>
          <p>{readOnly ? <>Viewing <Addr value={address} /> read-only.</> : 'Your notes, your assets on each chain, and what you can withdraw.'}</p>
        </div>
        <button className="btn" onClick={() => { refresh(); refreshWallet(); }}><RefreshCw className="i" />Refresh</button>
      </div>
      {msg && <div className={`notice ${msg.kind}`} role="status">{msg.text} {msg.tx && msg.explorer && <a href={`${msg.explorer}/tx/${msg.tx}`} target="_blank" rel="noreferrer">View transaction</a>}</div>}
      {due.length > 0 && !readOnly && (
        <div className="notice warn" role="status">
          {due.length === 1 ? 'One of your notes needs' : `${due.length} of your notes need`} funding: <button className="linkish" onClick={() => setTab('issued')}>see Issued notes</button>.
        </div>
      )}

      <nav className="seg pf-tabs" aria-label="Portfolio sections" role="tablist">
        {tabs.map(t => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.icon}{t.label}{t.n !== undefined && <span className="num dim">{t.n}</span>}{t.flag && <span className="pf-flag" aria-label="needs attention" />}
          </button>
        ))}
      </nav>

      {tab === 'subscribed' && (
        positions === undefined ? <p className="muted">Loading…</p>
          : subscribed.length === 0 ? <Empty title="You haven't subscribed to a note yet." body="Buy units in an open note: you pay USDG and receive units in one transaction." cta={<Link to="/" className="btn primary">See open notes</Link>} />
          : (
            <div className="card scroll-x" style={{ padding: 0 }}>
              <table className="t">
                <thead><tr><th>Note</th><th>Underlying</th><th>State</th><th className="r">Units</th><th className="r">Paid so far</th><th>Next</th></tr></thead>
                <tbody>
                  {subscribed.map(p => {
                    const sym = cashSymbol(byKey[p.chain]?.cfg, p.view.cashToken);
                    const paid = p.view.outcome ? p.view.outcome.perUnit * p.position.units : null;
                    return (
                      <tr key={p.id} {...rowProps(p.id, p.view.name)} data-note={p.id}>
                        <td><strong>{p.view.name}</strong><div className="xs muted">{byKey[p.chain]?.cfg.name ?? p.chain}</div></td>
                        <td><AssetStack syms={symsOf(p.view)} /></td>
                        <td><StatePill o={p.view} /></td>
                        <td className="r num">{fmtMoney(p.position.units, 0)}</td>
                        <td className="r num">{paid === null ? '—' : `${fmtMoney(paid)} ${sym}`}</td>
                        <td className="small muted">{nextEvent(p.view)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
      )}

      {tab === 'issued' && (
        notes === undefined ? <p className="muted">Loading…</p>
          : issued.length === 0 ? <Empty title="You haven't issued a note yet." body="Pick a product, set the terms and pledge collateral: investors' USDG comes to you as funding." cta={<Link to="/issue" className="btn primary">Issue a note</Link>} />
          : (
            <div className="card scroll-x" style={{ padding: 0 }}>
              <table className="t">
                <thead><tr><th>Note</th><th>State</th><th style={{ minWidth: 130 }}>Sold</th><th>Collateral</th><th className="r">Coverage</th><th>Next payment</th></tr></thead>
                <tbody>
                  {issued.map(({ id, view: o }) => {
                    const st = currentState(o);
                    const call = o.economics?.nextCall;
                    const pct = o.notional ? Math.min(100, (o.sold / o.notional) * 100) : 0;
                    return (
                      <tr key={id} {...rowProps(id, o.name)} data-note={id}>
                        <td><strong>{o.name}</strong><div className="xs muted">{byKey[o.chain]?.cfg.name ?? o.chain}</div></td>
                        <td><StatePill o={o} /></td>
                        <td><div className="bar"><span style={{ width: `${pct}%` }} /></div><div className="xs muted num" style={{ marginTop: 3 }}>{fmtMoney(o.sold, 0)} of {fmtMoney(o.notional, 0)}</div></td>
                        <td>{o.economics?.collateral.length ? <span className="coll-line" style={{ justifyContent: 'flex-start' }}>{o.economics.collateral.map(c => <Asset key={c.asset} sym={c.symbol === 'USD' ? cashSymbol(byKey[o.chain]?.cfg, o.cashToken) : c.symbol} size={16} />)}</span> : <span className="muted">—</span>}</td>
                        <td className="r num">{o.economics?.coveragePct != null ? fmtPct(o.economics.coveragePct) : '—'}</td>
                        <td className="small">
                          {call && !call.funded && (st.key === 'due' || st.key === 'grace')
                            ? <Link to={`/note/${encodeURIComponent(id)}`} className="btn primary sm" onClick={e => e.stopPropagation()}>Fund {fmtMoney(call.total)}</Link>
                            : <span className="muted">{nextEvent(o)}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
      )}

      {tab === 'withdraw' && (
        positions === undefined ? <p className="muted">Loading…</p>
          : withdrawable.length === 0 ? <Empty title="Nothing to withdraw right now." body="Coupons, redemptions, delivered stock and (for issuers) the USDG you raised appear here when they're paid." />
          : (
            <div className="card scroll-x" style={{ padding: 0 }}>
              <table className="t">
                <thead><tr><th>Note</th><th className="r">Cash</th><th>Tokens</th><th /></tr></thead>
                <tbody>
                  {withdrawable.map(p => {
                    const sym = cashSymbol(byKey[p.chain]?.cfg, p.view.cashToken);
                    const tokens = p.position.holdings.filter(h => h.asset > CASH_ASSET && BigInt(h.balance) > 0n);
                    return (
                      <tr key={p.id} {...rowProps(p.id, p.view.name)} data-note={p.id}>
                        <td><strong>{p.view.name}</strong><div className="xs muted">{p.view.issuer.toLowerCase() === address ? 'Raised as issuer' : 'Paid to you'}</div></td>
                        <td className="r num" data-cash><span className="asset" style={{ justifyContent: 'flex-end' }}><span className="num">{fmtMoney(p.position.cash)}</span><Asset sym={sym} size={16} /></span></td>
                        <td className="small">{tokens.length ? <span className="muted">{tokens.length} token{tokens.length > 1 ? 's' : ''}: withdraw on the note page</span> : <span className="muted">—</span>}</td>
                        <td className="r">
                          <button className="btn primary sm" disabled={readOnly || !(p.position.cash > 0) || !!busy || !byKey[p.chain]}
                            onClick={e => { e.stopPropagation(); withdraw(p.id, p.chain, p.view.name, p.position.cash); }}>
                            {busy === p.id ? 'Withdrawing…' : `Withdraw ${fmtMoney(p.position.cash)} ${sym}`}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
      )}

      {tab === 'collateral' && (
        <div className="stack">
          {!readOnly && <RedeemOnRobinhood />}
          {issued.some(n => n.view.economics?.collateral.length) ? (
            <div className="card scroll-x" style={{ padding: 0 }}>
              <table className="t">
                <thead><tr><th>Note</th><th>Collateral locked</th><th>Held on</th><th className="r">Value counted</th></tr></thead>
                <tbody>
                  {issued.flatMap(({ id, view: o }) => (o.economics?.collateral ?? []).map(c => (
                    <tr key={`${id}:${c.asset}`} {...rowProps(id, o.name)}>
                      <td><strong>{o.name}</strong></td>
                      <td><span className="asset"><span className="num">{fmtMoney(c.amount, c.amount < 1 ? 6 : 2)}</span><Asset sym={c.symbol === 'USD' ? cashSymbol(byKey[o.chain]?.cfg, o.cashToken) : c.symbol} size={16} /></span></td>
                      <td className="small">{/\.rh$/i.test(c.symbol) ? 'Robinhood Chain (via Chainlink CCIP)' : byKey[o.chain]?.cfg.name ?? o.chain}</td>
                      <td className="r num">{c.value == null ? '—' : fmtMoney(c.value)}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          ) : <Empty title="No collateral locked." body="Issuers lock collateral when they issue: on Arbitrum, or on Robinhood Chain where the stock tokens live. Receipts you hold after a default can be redeemed here." />}
        </div>
      )}

      {tab === 'wallet' && (
        wallet === null ? <p className="muted">Reading balances on each chain…</p> : (
          <div className="pf-chains">
            {wallet.map(c => (
              <section key={c.key} className="card">
                <h3>{c.name}</h3>
                {c.error ? <p className="small muted">Couldn't read this chain: {c.error}</p> : (
                  <ul className="pf-bal">
                    {c.balances.map(b => (
                      <li key={b.sym}>
                        <Asset sym={b.sym} size={20} />
                        <span className="xs muted">{b.kind === 'gas' ? 'gas' : b.kind === 'cash' ? 'cash' : b.kind === 'receipt' ? 'receipt' : b.kind === 'test' ? 'test token' : b.kind === 'stock' ? 'stock token' : ''}</span>
                        <span className="num r">{fmtMoney(b.amount, b.amount !== 0 && Math.abs(b.amount) < 1 ? 6 : 2)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )
      )}
    </main>
  );
}

function Empty({ title, body, cta }: { title: string; body: string; cta?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong><span className="small">{body}</span>{cta}</div>;
}
