/**
 * The workspace's stages, in order (Flow's right panel): Overview, Validate,
 * Payoff, Template, Issue. Each works on the workflow open on the canvas.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isAddress, zeroAddress } from 'viem';
import { signMessage } from 'wagmi/actions';
import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  dec, definitionId, FKIND, PRODUCT_LABELS, reservePerUnit, simulatePerf, templateMessage, totalPerUnit, underlyingLabel,
  type Compiled, type Issue, type ProductParams, type TemplateSource, type TemplateSummary, type WorkflowIR,
} from '@sn/core';
import { FIELD_LABEL, headline, obsIndex, planIssuance, type InputValue } from '@sn/sdk';
import PayoffChart from './PayoffChart';
import { api } from '../lib/api';
import { useAddress, useChains, useSigner } from '../lib/chains';
import { errText, fmtMoney, short } from '../lib/format';

export interface DocInfo {
  name: string;
  /** product: opened from a term sheet; custom: a BPMN workflow (edited, imported, from AI or blank). */
  origin: 'product' | 'custom';
  basis: ProductParams | null;
  edited: boolean;
  template?: TemplateSummary;
  /** From the AI's reading of a term sheet: the issuance size and schedule it stated. */
  hint?: { size?: number; every?: number; unit?: 'months' | 'days' | 'minutes' };
}

/** What a stage needs from the open workflow, compiled as it would be published. */
export interface Built { ir: WorkflowIR; c: Compiled; source: TemplateSource }

const Head = ({ title, sub }: { title: string; sub?: string }) => (
  <div className="section"><h2>{title}</h2>{sub && <p className="xs muted">{sub}</p>}</div>
);

// ---- Overview ---------------------------------------------------------------

export function OverviewPanel({ doc, info, onEditTerms, onStage }: {
  doc: DocInfo; info: { pools: string[]; steps: number; fields: string[]; errors: number; warnings: number };
  onEditTerms: () => void; onStage: (s: Stage) => void;
}) {
  const p = doc.basis;
  return (
    <>
      <Head title={doc.name} sub={doc.template ? `Template by ${short(doc.template.author)}` : undefined} />
      <div className="section">
        <div className="row">
          <span className={`pill ${doc.origin === 'product' && !doc.edited ? 'book' : 'live'}`}><span className="dot" />{doc.origin === 'product' && !doc.edited ? 'Stock product' : doc.edited && doc.origin === 'product' ? 'Edited: custom workflow' : 'Custom workflow'}</span>
          <span className="xs muted">{info.steps} steps · {info.pools.length} pools</span>
        </div>
        <p className="xs muted">{doc.origin === 'product' && !doc.edited
          ? 'Runs a verified payoff engine: the marketplace prices it from the reference payoff.'
          : 'The workflow on the canvas is the payoff: it runs exactly as drawn.'}</p>
      </div>
      {p && (
        <div className="section">
          <span className="label">Term sheet{doc.edited ? ' (started from)' : ''}</span>
          <div className="small"><strong>{PRODUCT_LABELS[p.productType]}</strong> on {underlyingLabel(p)}</div>
          <div className="xs muted">{headline(p)} · {p.observations} observation{p.observations > 1 ? 's' : ''} · issue price {p.issuePricePct}%</div>
          <div><button className="btn" onClick={onEditTerms}>Edit terms</button></div>
        </div>
      )}
      <div className="section">
        <span className="label">Pools</span>
        <div className="row">{info.pools.map(x => <span key={x} className="pill plain">{x}</span>)}</div>
        <span className="label" style={{ marginTop: 4 }}>Fields</span>
        <div className="xs muted num" style={{ lineHeight: 1.7 }}>{info.fields.join(', ') || 'none'}</div>
      </div>
      <div className="section">
        <span className="label">Next</span>
        <div className="row">
          <button className="btn" onClick={() => onStage('validate')}>{info.errors ? `Fix ${info.errors} error${info.errors > 1 ? 's' : ''}` : 'Validate'}</button>
          <button className="btn" onClick={() => onStage('template')}>Save as template</button>
          <button className="btn primary" onClick={() => onStage('issue')} disabled={info.errors > 0}>Issue</button>
        </div>
        <p className="xs muted">Select a step, gateway or flow on the canvas to edit what it does.</p>
      </div>
    </>
  );
}

// ---- Validate ---------------------------------------------------------------

export function ValidatePanel({ issues, onSelect }: { issues: { errors: Issue[]; warnings: Issue[] }; onSelect: (id: string) => void }) {
  const ok = !issues.errors.length && !issues.warnings.length;
  return (
    <>
      <Head title="Validate" sub="The validator and the engine's compiler check every change as you make it." />
      <div className="section">
        {ok && <div className="notice ok row"><CheckCircle2 className="i" />The engine accepts this workflow.</div>}
        <ul className="issues">
          {issues.errors.map((e, i) => <li key={`e${i}`} className={`err ${e.nodeId ? 'click' : ''}`} onClick={() => e.nodeId && onSelect(e.nodeId)}><AlertCircle className="i" style={{ verticalAlign: -2, marginRight: 6 }} />{e.message}</li>)}
          {issues.warnings.map((w, i) => <li key={`w${i}`} className={`warn ${w.nodeId ? 'click' : ''}`} onClick={() => w.nodeId && onSelect(w.nodeId)}><AlertTriangle className="i" style={{ verticalAlign: -2, marginRight: 6 }} />{w.message}</li>)}
        </ul>
      </div>
    </>
  );
}

// ---- Payoff (what-if) -------------------------------------------------------

export function PayoffPanel({ doc }: { doc: DocInfo }) {
  const p = doc.basis;
  const [path, setPath] = useState<number[]>(() => new Array(p?.observations ?? 0).fill(100));
  if (!p || doc.edited || doc.origin !== 'product') {
    return (
      <>
        <Head title="Payoff" />
        <div className="section"><p className="small muted">{p ? 'This workflow was edited, so its payoff is the workflow itself: there is no reference payoff to chart. Issue it and watch it run, or reopen the term sheet for a stock product.' : 'Custom workflows have no reference payoff: the workflow is the payoff.'}</p></div>
      </>
    );
  }
  const n = p.observations;
  const perfs = Array.from({ length: n }, (_, k) => (path[k] ?? 100) / 100);
  const r = simulatePerf(p, perfs);
  const basket = p.underlyings.length > 1;
  return (
    <>
      <Head title="Payoff" sub="The reference payoff the on-chain workflow is tested against." />
      <div className="section">
        <span className="label">Payout per 100 at maturity</span>
        <PayoffChart params={p} />
      </div>
      <div className="section">
        <span className="label">What if: {basket ? 'worst performance' : 'level'} at each observation, % of strike</span>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(70px, 1fr))' }}>
          {Array.from({ length: n }, (_, k) => (
            <div key={k} className="field">
              <label htmlFor={`wi-${k}`}>Obs {k + 1}</label>
              <input id={`wi-${k}`} type="number" value={path[k] ?? 100} onChange={e => setPath(x => { const y = [...x]; y[k] = Number(e.target.value); return y; })} />
            </div>
          ))}
        </div>
        <table className="t">
          <tbody>
            {r.coupons.map((c, k) => <tr key={k}><td>Observation {k + 1}{r.calledAt === k + 1 ? ' · autocalled' : ''}</td><td className="r num">{(c * 100).toFixed(2)}</td></tr>)}
            <tr><td>Redemption</td><td className="r num">{(r.redemptionCash * 100).toFixed(2)}</td></tr>
            <tr><td><strong>Total per 100</strong></td><td className="r num"><strong>{(totalPerUnit(r) * 100).toFixed(2)}</strong></td></tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---- Template -----------------------------------------------------------------

export function TemplatePanel({ doc, build, onSaved }: { doc: DocInfo; build: () => Promise<Built>; onSaved: (t: TemplateSummary) => void }) {
  const me = useAddress();
  const { wagmi } = useChains();
  const [name, setName] = useState(doc.template && !doc.edited ? doc.template.name : doc.name);
  const [description, setDescription] = useState(doc.template && !doc.edited ? doc.template.description : '');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const save = async () => {
    if (!me) return;
    setMsg(null);
    try {
      setBusy('Compiling…');
      const { c, source } = await build();
      const definition = definitionId(c);
      setBusy('Sign the template with your wallet…');
      const signature = await signMessage(wagmi, { message: templateMessage(definition) });
      setBusy('Saving to the template library…');
      const j = await api.saveTemplate({ ...source, definition, name: name.trim(), description, author: me }, signature);
      setMsg({ kind: 'ok', text: `Saved "${j.name}". Issuers can now pick it from Issue → Templates, on any network.` });
      onSaved(j);
    } catch (e) { setMsg({ kind: 'err', text: errText(e) }); }
    finally { setBusy(''); }
  };
  return (
    <>
      <Head title="Save as template" sub="Publish this workflow so that you, or any issuer, can issue it again from the template library." />
      <div className="section">
        {doc.template && !doc.edited && <div className="notice info">Opened from the template "{doc.template.name}" by {short(doc.template.author)}. Saving again under a new name lists it separately.</div>}
        <div className="field"><label htmlFor="tp-name">Name</label><input id="tp-name" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor="tp-desc">Description</label><textarea id="tp-desc" rows={3} maxLength={280} value={description} onChange={e => setDescription(e.target.value)} placeholder="Who it is for, what is special about it" /></div>
        <p className="xs muted">A template is identified by the hash of its compiled workflow, the same on every network. The library checks your signature, recompiles the workflow and accepts it only if it lands on that hash. It goes on-chain the first time someone issues it.</p>
        <button className="btn primary lg" disabled={!me || !!busy || !name.trim()} onClick={save}>
          {!me ? 'Connect a wallet' : busy || 'Publish template'}
        </button>
        {msg && <div className={`notice ${msg.kind}`} role="status">{msg.text}</div>}
      </div>
    </>
  );
}

// ---- Issue ------------------------------------------------------------------

const toLocalInput = (t: number) => { const d = new Date(t * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const KIND_NAME: Record<number, string> = Object.fromEntries(Object.entries(FKIND).map(([k, v]) => [v, k]));

export function IssuePanel({ doc, built }: { doc: DocInfo; built: Built | null }) {
  const nav = useNavigate();
  const me = useAddress();
  const { config, byKey } = useChains();
  const signer = useSigner();
  const plan = useMemo(() => { try { return built ? planIssuance(built.ir, built.c) : null; } catch (e) { return e instanceof Error ? e.message : String(e); } }, [built]);
  const [chainKey, setChainKey] = useState(config.chains[0]?.key ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [size, setSize] = useState(doc.hint?.size ?? 10_000);
  const [strikeIn, setStrikeIn] = useState(5);
  const [every, setEvery] = useState({ n: 3, unit: 'minutes' as 'minutes' | 'days' | 'months' });
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [isin] = useState(() => 'XS' + String(Date.now()).slice(-10));
  const chain = byKey[chainKey];

  if (!built) return <><Head title="Issue" /><div className="section"><p className="small muted">Fix the errors in Validate first.</p></div></>;
  if (typeof plan === 'string' || !plan) return <><Head title="Issue" /><div className="section"><div className="notice err">{plan}</div></div></>;

  const all = [plan.start, ...plan.steps];
  const inputs = all.flatMap(s => s.inputs);
  const hasSchedule = plan.dateFields.includes('strikeDate');
  const strikeAt = Math.floor(Date.now() / 60000) * 60 + strikeIn * 60;
  const dateOf = (name: string) => {
    const k = obsIndex(name);
    if (k === 0) return strikeAt;
    if (every.unit === 'months') { const d = new Date(strikeAt * 1000); d.setUTCMonth(d.getUTCMonth() + every.n * k); return Math.floor(d.getTime() / 1000); }
    return strikeAt + k * every.n * (every.unit === 'days' ? 86400 : 60);
  };
  const p = doc.basis;
  const sym = chain?.cfg.stablecoin.symbol ?? 'USDC';
  const perUnitReserve = p ? (reservePerUnit(p) ?? (p.participationPct ?? 0) / 100) : 0;
  const reserve = Math.ceil(size * perUnitReserve * 100) / 100;
  const auto = (name: string): string | null => {
    if (name === 'notional') return String(size);
    if (name === 'isin') return values.isin ?? isin;
    if (hasSchedule && plan.dateFields.includes(name)) return String(dateOf(name));
    if (name === 'reserve' && p && values.reserve === undefined) return reserve.toFixed(2);
    return null;
  };
  const kindOf = (name: string) => inputs.find(f => f.name === name)?.kind;
  const valueOf = (name: string) => auto(name) ?? values[name] ?? (kindOf(name) === FKIND.Date ? toLocalInput(strikeAt) : '');
  const generic = inputs.filter(f => !(['notional', 'isin'].includes(f.name) || (hasSchedule && plan.dateFields.includes(f.name))));
  // Cash settles in the network's stablecoin; a delivered underlying (tETH, tTSLA…) needs its token on that network.
  const isCash = (token?: string) => !token || /^(t?USD|USDC|USDG)$/i.test(token);
  const tokenOf = (token?: string) => (isCash(token) ? chain?.cfg.stablecoin.address : chain?.cfg.tokens?.[token!]);
  const unsupported = built.ir.assets.filter(a => a.kind === 'cash' && !tokenOf(a.token)).map(a => a.token ?? 'cash');

  const issue = async () => {
    if (!me || !chain) return;
    setBusy(true); setError(''); setProgress([]);
    const step = (s: string) => setProgress(x => [...x, s]);
    try {
      if (hasSchedule && strikeAt < Date.now() / 1000 + 60) throw new Error('The strike date must be at least a minute away.');
      if (unsupported.length) throw new Error(`${chain.cfg.name} has no token configured for ${unsupported.join(', ')}: physical delivery is not available there yet.`);
      const value = (f: { name: string; kind: number }): InputValue => {
        const raw = valueOf(f.name).trim();
        if (!raw) throw new Error(`Enter ${FIELD_LABEL[f.name] ?? f.name}.`);
        if (f.kind === FKIND.Text) return { kind: 'text', value: raw };
        if (f.kind === FKIND.Party) { if (!isAddress(raw)) throw new Error(`${f.name}: enter an address.`); return { kind: 'party', value: raw }; }
        if (f.kind === FKIND.Date) return { kind: 'number', value: BigInt(/^\d+$/.test(raw) ? raw : Math.floor(new Date(raw).getTime() / 1000)) };
        if (f.kind === FKIND.Bool) return { kind: 'number', value: raw === 'true' ? 1n : 0n };
        if (f.kind === FKIND.Int) return { kind: 'number', value: BigInt(raw) };
        return { kind: 'number', value: dec(raw) };
      };
      const byStep = Object.fromEntries(all.map(s => [s.index, Object.fromEntries(s.inputs.map(f => [f.field, value(f)]))]));
      const { c } = built;
      step(`Workflow compiled: ${c.def.steps.length} steps, ${c.bytes.length.toLocaleString()} bytes.`);
      const cashTokens = Object.fromEntries(plan.cashAssets.map(a => [a, tokenOf(built.ir.assets[a].token)!]));
      const w = await signer(chainKey);
      const r = await chain.adapter.issue(w, { definition: c.bytes, def: c.def, plan, ref: BigInt(Date.now()), cashTokens, inputs: byStep }, step);
      step('Book open.');
      nav(`/note/${encodeURIComponent(r.id)}`);
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };

  const deposits = plan.steps.filter(s => s.deposits.length);
  return (
    <>
      <Head title="Issue" sub="Pre-trade terms for this issuance. Publishing opens the book: investors subscribe until the strike date, then Chainlink CRE takes over." />
      <div className="section">
        {config.chains.length > 1 && (
          <div className="field">
            <label htmlFor="is-chain">Network</label>
            <select id="is-chain" value={chainKey} onChange={e => setChainKey(e.target.value)}>
              {config.chains.map(c => <option key={c.key} value={c.key}>{c.name}{c.cre ? '' : ' (fallback keeper)'}</option>)}
            </select>
          </div>
        )}
        <span className="label">Roles</span>
        <p className="xs muted">Your wallet holds {plan.heldPools.join(', ')}{plan.openPools.length ? `; ${plan.openPools.join(', ')} is open to anyone` : ''}. Runs: {all.map(s => s.name).join(' → ')}.</p>
      </div>
      <div className="section">
        <div className="form-grid">
          {inputs.some(f => f.name === 'notional') && (
            <div className="field"><label htmlFor="is-size">{FIELD_LABEL.notional.replace('USDC', sym)}</label><input id="is-size" type="number" min={1} value={size} onChange={e => setSize(Number(e.target.value))} /></div>
          )}
          {inputs.some(f => f.name === 'isin') && (
            <div className="field"><label htmlFor="is-isin">{FIELD_LABEL.isin}</label><input id="is-isin" maxLength={32} value={values.isin ?? isin} onChange={e => setValues(v => ({ ...v, isin: e.target.value }))} /></div>
          )}
        </div>
      </div>
      {hasSchedule && (
        <div className="section">
          <span className="label">Schedule</span>
          <div className="form-grid">
            <div className="field"><label htmlFor="is-strike">Strike in (minutes)</label><input id="is-strike" type="number" min={2} value={strikeIn} onChange={e => setStrikeIn(Math.max(2, Number(e.target.value) || 2))} /></div>
            <div className="field">
              <label htmlFor="is-every">Observe every</label>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input id="is-every" type="number" min={1} value={every.n} onChange={e => setEvery({ ...every, n: Number(e.target.value) || 1 })} style={{ width: 70 }} />
                <select aria-label="Interval unit" value={every.unit} onChange={e => setEvery({ ...every, unit: e.target.value as typeof every.unit })}>
                  <option value="minutes">minutes</option><option value="days">days</option><option value="months">months</option>
                </select>
              </div>
            </div>
          </div>
          <p className="xs muted">Strike {new Date(strikeAt * 1000).toLocaleString()}; then {plan.dateFields.filter(f => f !== 'strikeDate').map(f => (every.unit === 'minutes' ? new Date(dateOf(f) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date(dateOf(f) * 1000).toLocaleDateString([], { dateStyle: 'medium' }))).join(' · ')}. Minutes apart runs a whole lifecycle on-chain while you watch.</p>
        </div>
      )}
      {generic.length > 0 && (
        <div className="section">
          <span className="label">Terms</span>
          <div className="form-grid">
            {generic.map(f => (
              <div key={f.name} className="field">
                <label htmlFor={`is-${f.name}`}>{(FIELD_LABEL[f.name] ?? f.name).replace('USDC', sym)} <span className="dim">({KIND_NAME[f.kind]})</span></label>
                <input id={`is-${f.name}`} type={f.kind === FKIND.Date ? 'datetime-local' : 'text'} value={valueOf(f.name)}
                  onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))} />
                {f.name === 'reserve' && p && <span className="hint">Worst case above par: {fmtMoney(reserve)} {sym}{p.productType === 'ppn' ? ' (sized for a 100% rise)' : ''}.</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="section">
        {deposits.length > 0 && <p className="xs muted">{deposits.map(s => s.name).join(', ')} {deposits.length > 1 ? 'deposit' : 'deposits'} from your wallet ({[...new Set(built.ir.assets.filter(a => a.kind === 'cash').map(a => (isCash(a.token) ? sym : a.token!)))].join(', ')}); the wallet asks you to approve exactly each amount first. Test tokens come from the faucet in the top bar.</p>}
        {unsupported.length > 0 && <div className="notice warn">Physical delivery needs {unsupported.join(', ')} on {chain?.cfg.name}, which this deployment does not configure yet.</div>}
        <button className="btn primary lg" disabled={!me || busy || !chain} onClick={issue}>
          {me ? (busy ? 'Issuing…' : 'Publish and open the book') : 'Connect a wallet to issue'}
        </button>
        {progress.length > 0 && <ol className="xs muted" style={{ margin: 0, paddingLeft: 18 }} data-progress>{progress.map((s, i) => <li key={i}>{s}</li>)}</ol>}
        {error && <div className="notice err" role="alert">{error}</div>}
        {chain?.cfg.explorer && <a className="xs" href={`${chain.cfg.explorer}/address/${chain.cfg.engine}`} target="_blank" rel="noreferrer">Engine on {chain.cfg.name}</a>}
        {chain && <span className="xs muted">Engine {short(chain.cfg.engine)}{chain.cfg.engine === zeroAddress ? ' (not deployed)' : ''} · {chain.cfg.cre ? 'reports by Chainlink CRE' : 'reports by the fallback keeper'}</span>}
      </div>
    </>
  );
}

export type Stage = 'design' | 'validate' | 'payoff' | 'template' | 'issue';
