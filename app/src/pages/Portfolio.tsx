import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CASH_ASSET, PHASE_LABEL } from '@sn/sdk';
import { useAddress, useChains, useSigner } from '../lib/chains';
import { errText, fmtMoney } from '../lib/format';
import { usePortfolio } from '../lib/live';

export default function Portfolio() {
  const address = useAddress();
  const { byKey } = useChains();
  const signer = useSigner();
  const { positions, refresh } = usePortfolio(address ?? undefined);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; tx?: string; explorer?: string } | null>(null);

  if (!address) return <main className="page"><div className="empty"><strong>Connect a wallet to see your notes.</strong><span className="small">Your units, the coupons you have been paid, and cash you can withdraw, on every network.</span></div></main>;
  if (!positions) return <main className="page"><p className="muted">Loading your positions…</p></main>;

  const withdraw = async (id: string, chain: string, name: string, cash: number) => {
    setBusy(id); setMsg(null);
    try {
      const w = await signer(chain);
      const r = await byKey[chain].adapter.withdraw(w, id, CASH_ASSET);
      setMsg({ kind: 'ok', text: `Withdrew ${fmtMoney(cash)} ${byKey[chain].cfg.stablecoin.symbol} from ${name}.`, tx: r.tx[r.tx.length - 1], explorer: byKey[chain].cfg.explorer });
      refresh();
    } catch (e) { setMsg({ kind: 'err', text: errText(e) }); }
    finally { setBusy(''); }
  };

  return (
    <main className="page">
      <div className="page-head"><div><h1>Portfolio</h1><p>Notes you hold or issued, and the cash each one owes you: coupons and redemptions for holders, the subscriptions raised for issuers.</p></div></div>
      {msg && <div className={`notice ${msg.kind}`} role="status">{msg.text} {msg.tx && msg.explorer && <a href={`${msg.explorer}/tx/${msg.tx}`} target="_blank" rel="noreferrer">View transaction</a>}</div>}
      {positions.length === 0 ? (
        <div className="empty"><strong>You don't hold any notes yet.</strong><span className="small">Buy into an open note from the marketplace, or issue your own.</span><Link to="/" className="btn">See open notes</Link></div>
      ) : (
        <div className="card scroll-x" style={{ padding: 0 }}>
          <table className="t">
            <thead><tr><th>Note</th><th>Network</th><th>Role</th><th>Status</th><th className="r">Units</th><th className="r">Cash to withdraw</th><th /></tr></thead>
            <tbody>
              {positions.map(p => {
                const issuer = p.view.issuer === address;
                const sym = byKey[p.chain]?.cfg.stablecoin.symbol ?? 'USDG';
                return (
                  <tr key={p.id} data-note={p.id}>
                    <td><Link to={`/note/${encodeURIComponent(p.id)}`}>{p.view.name}</Link><br /><span className="small muted">{p.view.isin}</span></td>
                    <td className="small">{byKey[p.chain]?.cfg.name ?? p.chain}</td>
                    <td>{issuer ? 'Issuer' : 'Investor'}</td>
                    <td><span className={`pill ${p.view.phase}`}><span className="dot" />{PHASE_LABEL[p.view.phase]}</span></td>
                    <td className="r num">{fmtMoney(p.position.units)}</td>
                    <td className="r num" data-cash>{fmtMoney(p.position.cash)} {sym}
                      {p.position.holdings.some(h => h.asset > CASH_ASSET && BigInt(h.balance) > 0n) && <div className="xs muted"><Link to={`/note/${encodeURIComponent(p.id)}`}>+ tokens to withdraw</Link> (delivered, or collateral after a default)</div>}
                    </td>
                    <td className="r"><button className="btn" disabled={!(p.position.cash > 0) || !!busy || !byKey[p.chain]} onClick={() => withdraw(p.id, p.chain, p.view.name, p.position.cash)}>{busy === p.id ? 'Withdrawing…' : 'Withdraw'}</button></td>
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
