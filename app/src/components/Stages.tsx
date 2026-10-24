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
  collateralTokenOf, dec, definitionId, economicsOf, FKIND, MAX_GRACE_DAYS, PRODUCT_LABELS, ROBINHOOD_STOCK_TOKENS, simulateNote, simulatePerf, STOCK_TOKEN_FAUCETS,
  templateMessage, totalPerUnit, underlyingLabel,
  type CollateralSymbol, type Compiled, type Issue, type ProductParams, type TemplateSource, type TemplateSummary, type WorkflowIR,
} from '@sn/core';
import { FIELD_LABEL, fieldLabel, headline, obsIndex, planIssuance, type InputValue } from '@sn/sdk';
import PayoffChart from './PayoffChart';
import { api } from '../lib/api';
import { useAddress, useChains, useSigner } from '../lib/chains';
import { Steps } from './ui';
import { useVerifiedEmail } from './VerifiedEmail';
import { LockOnRobinhood } from './CrossChainCollateral';
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
          <span className="xs muted">{info.steps} steps</span>
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
        <details className="adv">
          <summary>Advanced: parties and fields</summary>
          <div className="adv-body">
            <span className="label">Parties</span>
            <div className="row">{info.pools.map(x => <span key={x} className="pill plain">{x}</span>)}</div>
            <span className="label">Fields</span>
            <div className="xs muted num" style={{ lineHeight: 1.7 }}>{info.fields.join(', ') || 'none'}</div>
          </div>
        </details>
      </div>
      <div className="section">
        <span className="label">Next</span>
        <button className="btn primary lg" onClick={() => onStage('issue')} disabled={info.errors > 0}>{info.errors ? 'Fix the errors first' : 'Set the terms and issue →'}</button>
        <div className="row">
          {info.errors > 0 && <button className="btn" onClick={() => onStage('validate')}>Fix {info.errors} error{info.errors > 1 ? 's' : ''}</button>}
          <button className="btn" onClick={() => onStage('payoff')}>See the payoff</button>
          <button className="btn" onClick={() => onStage('template')}>Save as template</button>
        </div>
        <p className="xs muted">Advanced: select a step, gateway or flow on the canvas to change what it does.</p>
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
  const [ratioPct, setRatioPct] = useState<number | null>(null);
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
  const eco = economicsOf(p);
  const ratio = (ratioPct ?? eco.collateralRatioPct) / 100;
  // The issuer's side along the same path, per 100 of face: what it must fund for each period, and by when.
  const calls = simulateNote(p, { perfs, sold: 100, ratio: 0, collateral: [] }).calls;
  return (
    <>
      <Head title="Payoff" sub="The reference payoff the on-chain workflow is tested against, and what the issuer must fund to pay it." />
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
      <div className="section" data-funding-calls>
        <span className="label">The issuer's funding calls along this path (per 100 of face)</span>
        <table className="t">
          <thead><tr><th>Period</th><th>Due by</th><th className="r">Issuer funds</th></tr></thead>
          <tbody>
            {calls.length === 0 && <tr><td colSpan={3} className="muted small">Nothing to pay along this path.</td></tr>}
            {calls.map(c => (
              <tr key={c.period}>
                <td>{c.period}{c.final ? (r.calledAt === c.period ? ' · autocall' : ' · maturity') : ''}</td>
                <td className="small">observation {c.period} + {eco.settlementLagDays} day{eco.settlementLagDays === 1 ? '' : 's'}; grace {eco.gracePeriodDays} day{eco.gracePeriodDays === 1 ? '' : 's'}</td>
                <td className="r num">{c.perUnit ? (c.perUnit * 100).toFixed(2) : ''}{c.deliver ? `${c.perUnit ? ' + ' : ''}${(c.deliver.perUnit * 100).toFixed(4)} t${c.deliver.symbol}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="xs muted">The subscriptions go to the issuer when the book closes; each payment is a call on the issuer, funded into the note's escrow before its date. Unfunded at the end of the grace period, the note defaults.</p>
      </div>
      <div className="section" data-default-outcome>
        <span className="label">If the issuer defaults</span>
        <div className="field">
          <label htmlFor="po-ratio">Collateral ratio, % of the notional</label>
          <input id="po-ratio" type="number" min={0} max={1000} value={ratioPct ?? eco.collateralRatioPct} onChange={e => setRatioPct(Number(e.target.value))} />
        </div>
        <p className="small">The escrow holds collateral worth at least <strong className="num">{(ratio * 100).toFixed(2)}</strong> per 100 of face, counted after haircuts ({eco.collateral.map(c => `${c.symbol === 'USD' ? 'USDG' : `t${c.symbol}`} ${c.haircutPct}%`).join(', ')}) at the last Chainlink prices, plus any payment the issuer had funded but not yet paid. {eco.defaultRule === 'cap-at-owed'
          ? 'Holders take what they are owed from it, pro rata (the missed payment plus par: 100 per 100 of face plus the coupon), stablecoin first, then collateral at market value; anything above that goes back to the issuer.'
          : 'Holders receive all of it, pro rata, whatever it is worth.'} <span className="xs muted" data-default-rule={eco.defaultRule}>(Default rule: {eco.defaultRule === 'cap-at-owed' ? 'capped at what is owed' : 'all to holders'}.)</span></p>
        <p className="xs muted">{ratio >= 1 ? 'Fully secured: on a default, collateral at least matches the face value outstanding.' : `Partly secured: up to ${((1 - ratio) * 100).toFixed(0)} per 100 of face rests on the issuer's credit.`} Coverage is checked at the strike and every observation; below the requirement the issuer must top up within the grace period.</p>
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

/** What the guided issue flow (pages/IssueWizard.tsx) has already asked; with `compact` those sections are hidden. */
export interface IssuePreset {
  chainKey?: string; size?: number; strikeIn?: number; every?: { n: number; unit: 'minutes' | 'days' | 'months' };
  ratioPct?: number; haircuts?: Record<string, number>; timing?: { lag: number; grace: number } | null;
}

export function IssuePanel({ doc, built, preset, compact = false }: { doc: DocInfo; built: Built | null; preset?: IssuePreset; compact?: boolean }) {
  const nav = useNavigate();
  const me = useAddress();
  const { config, byKey } = useChains();
  const signer = useSigner();
  const plan = useMemo(() => { try { return built ? planIssuance(built.ir, built.c) : null; } catch (e) { return e instanceof Error ? e.message : String(e); } }, [built]);
  const [chainKey, setChainKey] = useState(preset?.chainKey ?? config.chains[0]?.key ?? '');
  const emailGate = useVerifiedEmail(); // a verified email before issuing
  const [values, setValues] = useState<Record<string, string>>({});
  const [size, setSize] = useState(preset?.size ?? doc.hint?.size ?? 10_000);
  const [strikeIn, setStrikeIn] = useState(preset?.strikeIn ?? 5);
  const [every, setEvery] = useState(preset?.every ?? { n: 3, unit: 'minutes' as 'minutes' | 'days' | 'months' });
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [isin] = useState(() => 'XS' + String(Date.now()).slice(-10));
  const ecoDefaults = economicsOf(doc.basis ?? { productType: 'fcn', name: '', issuePricePct: 100, underlyings: [], observations: 1 });
  const [ratioPct, setRatioPct] = useState(preset?.ratioPct ?? ecoDefaults.collateralRatioPct);
  const [haircuts, setHaircuts] = useState<Record<string, number>>(() => preset?.haircuts ?? Object.fromEntries(ecoDefaults.collateral.map(c => [c.symbol, c.haircutPct])));
  const [pledges, setPledges] = useState<Record<string, string>>({});
  const [timing, setTiming] = useState<{ lag: number; grace: number } | null>(preset?.timing ?? null);
  const chain = byKey[chainKey];
  // Collateral locked on Robinhood Chain: the note pledges the CCIP receipts (TSLA.rh…), not the token itself.
  const remote = doc.basis?.collateralChain === 'robinhood';
  const tokOf = (c: string) => collateralTokenOf(doc.basis ?? {}, c as CollateralSymbol)?.token ?? (c === 'USD' ? (chain?.cfg.stablecoin.symbol ?? 'USDG') : `t${c}`);

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
  const sym = chain?.cfg.stablecoin.symbol ?? 'USDG';
  // Collateral and payment timing: per issuance. Minutes-apart demo schedules get seconds; real ones, days.
  const names = new Set(inputs.map(f => f.name));
  const collateralSyms = [...names].filter(n => n.startsWith('pledge_')).map(n => n.slice(7));
  const stepSec = every.unit === 'minutes' ? every.n * 60 : every.unit === 'days' ? every.n * 86400 : every.n * 30 * 86400;
  const demo = every.unit === 'minutes';
  const t = timing ?? (demo
    ? { lag: Math.min(30, Math.floor(stepSec / 4)), grace: Math.min(60, Math.floor(stepSec / 3)) }
    : { lag: ecoDefaults.settlementLagDays * 86400, grace: ecoDefaults.gracePeriodDays * 86400 });
  const required = (ratioPct / 100) * size;
  const pledgeOf = (c: string) => pledges[c] ?? (c === 'USD' && collateralSyms.length === 1 ? String(Math.ceil(required / ((haircuts[c] ?? 100) / 100) * 100) / 100) : '');
  const usdCoverage = collateralSyms.reduce((a, c) => a + (c === 'USD' ? (Number(pledgeOf(c)) || 0) * (haircuts[c] ?? 100) / 100 : 0), 0);
  const timingBad = hasSchedule && t.lag + t.grace > stepSec ? 'The payment date plus grace must fall before the next observation: shorten the lag or grace, or observe less often.' : t.grace > MAX_GRACE_DAYS * 86400 ? `The grace period is at most ${MAX_GRACE_DAYS} days.` : '';
  const auto = (name: string): string | null => {
    if (name === 'notional') return String(size);
    if (name === 'isin') return values.isin ?? isin;
    if (hasSchedule && plan.dateFields.includes(name)) return String(dateOf(name));
    if (name === 'lag') return String(t.lag);
    if (name === 'grace') return String(t.grace);
    if (name === 'collateralRatio') return String(ratioPct / 100);
    if (name.startsWith('haircut_')) return String((haircuts[name.slice(8)] ?? 100) / 100);
    if (name.startsWith('pledge_')) return pledgeOf(name.slice(7));
    return null;
  };
  const kindOf = (name: string) => inputs.find(f => f.name === name)?.kind;
  const valueOf = (name: string) => auto(name) ?? values[name] ?? (kindOf(name) === FKIND.Date ? toLocalInput(strikeAt) : '');
  const handled = (n: string) => ['notional', 'isin', 'lag', 'grace', 'collateralRatio'].includes(n) || /^(haircut|pledge)_/.test(n) || (hasSchedule && plan.dateFields.includes(n));
  const generic = inputs.filter(f => !handled(f.name));
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
      if (unsupported.length) throw new Error(`${chain.cfg.name} has no token configured for ${unsupported.join(', ')}.${unsupported.some(t => ROBINHOOD_STOCK_TOKENS[t]?.token === t) ? ' This note uses Robinhood Chain\'s own stock tokens: until the cross-chain vaults are live, issue it on Robinhood Chain testnet.' : ''}`);
      if (timingBad) throw new Error(timingBad);
      const value = (f: { name: string; kind: number }): InputValue => {
        const raw = valueOf(f.name).trim();
        if (!raw) throw new Error(`Enter ${fieldLabel(f.name)}.`);
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
      {!compact && <Head title="Issue this note" sub="Four steps. Publishing opens the book: investors subscribe until the strike date and their USDG is yours. Chainlink CRE then checks prices on each date, and you fund each payment before it falls due." />}
      <div className="section">
        {!compact && <div className="step-h"><span className="n">1</span><h3>Network and size</h3></div>}
        {config.chains.length > 1 && !compact && (
          <div className="field">
            <label htmlFor="is-chain">Network</label>
            <select id="is-chain" value={chainKey} onChange={e => setChainKey(e.target.value)}>
              {config.chains.map(c => <option key={c.key} value={c.key}>{c.name}{c.key === 'robinhood-testnet' ? ' (asset chain: stock tokens)' : ''}{c.cre ? '' : ' (fallback keeper)'}</option>)}
            </select>
          </div>
        )}
        <div className="form-grid" hidden={compact}>
          {inputs.some(f => f.name === 'notional') && (
            <div className="field"><label htmlFor="is-size">{FIELD_LABEL.notional.replace('USDC', sym)}</label><input id="is-size" type="number" min={1} value={size} onChange={e => setSize(Number(e.target.value))} /></div>
          )}
          {inputs.some(f => f.name === 'isin') && (
            <div className="field"><label htmlFor="is-isin">{FIELD_LABEL.isin}</label><input id="is-isin" maxLength={32} value={values.isin ?? isin} onChange={e => setValues(v => ({ ...v, isin: e.target.value }))} /></div>
          )}
        </div>
      </div>
      {hasSchedule && !compact && (
        <div className="section">
          <div className="step-h"><span className="n">2</span><h3>Dates</h3></div>
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
      {names.has('collateralRatio') && (
        <div className="section" data-collateral>
          <div className="step-h">{compact ? <h3>Collateral to lock</h3> : <><span className="n">3</span><h3>Collateral you lock</h3></>}</div>
          <p className="xs muted">Locked in the note until every payment is made. If you miss one, holders take what they're owed from it.</p>
          <div className="form-grid">
            <div className="field" hidden={compact}>
              <label htmlFor="is-ratio">Collateral ratio, % of the notional</label>
              <input id="is-ratio" type="number" min={0} max={1000} value={ratioPct} onChange={e => setRatioPct(Number(e.target.value))} />
              <span className="hint">Required: {fmtMoney(required)} {sym} of collateral value, checked at the strike and every observation.</span>
            </div>
            {collateralSyms.map(c => {
              const tok = tokOf(c);
              return (
                <div key={c} className="field">
                  <label htmlFor={`is-pledge-${c}`}>{tok} pledged{compact ? ` · ${haircuts[c] ?? 100}% counted` : <> · haircut <input aria-label={`${tok} share of value counted, %`} type="number" min={0} max={100} value={haircuts[c] ?? 100} onChange={e => setHaircuts(h => ({ ...h, [c]: Number(e.target.value) }))} style={{ width: 64, display: 'inline-block' }} />% counted</>}</label>
                  <input id={`is-pledge-${c}`} inputMode="decimal" value={pledgeOf(c)} onChange={e => setPledges(x => ({ ...x, [c]: e.target.value }))} placeholder={`${tok} amount`} />
                  {c !== 'USD' && <span className="hint">Valued by Chainlink at the strike; with {collateralSyms.length > 1 ? 'the other assets' : 'nothing else'} it must cover {fmtMoney(required)} {sym}.</span>}
                </div>
              );
            })}
          </div>
          {remote && <LockOnRobinhood needed={collateralSyms.map(c => ({ receipt: tokOf(c), amount: Number(pledgeOf(c)) || 0 }))} />}
          {remote && chain?.cfg.crossChain?.role !== 'home' && <p className="xs err">Collateral locked on Robinhood Chain backs notes on Arbitrum Sepolia: pick that network above.</p>}
          {collateralSyms.every(c => c === 'USD') && <p className={`xs ${usdCoverage + 1e-9 >= required ? 'muted' : 'err'}`}>Coverage at the strike: {fmtMoney(usdCoverage)} {sym} of {fmtMoney(required)} required{usdCoverage + 1e-9 >= required ? '.' : ': top it up, or the note goes into a margin call at the strike.'}</p>}
        </div>
      )}
      {names.has('grace') && !compact && (
        <div className="section" data-timing>
          <div className="step-h"><span className="n">4</span><h3>Paying holders</h3></div>
          <div className="form-grid">
            <div className="field"><label htmlFor="is-lag">Settlement lag ({demo ? 'seconds' : 'days'} after each observation)</label><input id="is-lag" type="number" min={0} value={demo ? t.lag : t.lag / 86400} onChange={e => setTiming({ ...t, lag: Math.max(0, Number(e.target.value) || 0) * (demo ? 1 : 86400) })} /></div>
            <div className="field"><label htmlFor="is-grace">Grace period ({demo ? 'seconds' : 'days'}, up to {MAX_GRACE_DAYS} days)</label><input id="is-grace" type="number" min={0} value={demo ? t.grace : t.grace / 86400} onChange={e => setTiming({ ...t, grace: Math.max(0, Number(e.target.value) || 0) * (demo ? 1 : 86400) })} /></div>
          </div>
          <p className="xs muted">The subscriptions are yours when the book closes. Each observation fixes what is owed; fund it into escrow before the payment date ({demo ? `${t.lag}s` : `${t.lag / 86400} days`} after the observation). Unfunded, a {demo ? `${t.grace}s` : `${t.grace / 86400}-day`} grace period runs; unfunded after that, the collateral goes to the holders.</p>
          {timingBad && <div className="notice warn">{timingBad}</div>}
        </div>
      )}
      {generic.length > 0 && (
        <div className="section">
          <span className="label">Other terms</span>
          <div className="form-grid">
            {generic.map(f => (
              <div key={f.name} className="field">
                <label htmlFor={`is-${f.name}`}>{fieldLabel(f.name).replace('USDC', sym)} <span className="dim">({KIND_NAME[f.kind]})</span></label>
                <input id={`is-${f.name}`} type={f.kind === FKIND.Date ? 'datetime-local' : 'text'} value={valueOf(f.name)}
                  onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))} />
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="section">
        {deposits.length > 0 && <p className="xs muted">{deposits.map(s => s.name).join(', ')} {deposits.length > 1 ? 'deposit' : 'deposits'} the collateral from your wallet; the wallet asks you to approve exactly each amount first. Test tokens come from the faucet in the top bar{built.ir.assets.some(a => a.token && ROBINHOOD_STOCK_TOKENS[a.token]?.token === a.token) ? <>; Robinhood Chain's own TSLA and AMZN come from <a href={STOCK_TOKEN_FAUCETS['robinhood-testnet']} target="_blank" rel="noreferrer">Robinhood's faucet</a></> : ''}.</p>}
        {unsupported.length > 0 && <div className="notice warn">This note needs {unsupported.join(', ')} on {chain?.cfg.name}, which this deployment does not configure yet.</div>}
        <button className="btn primary lg" disabled={!me || busy || !chain} onClick={() => void emailGate.require(chainKey, issue)}>
          {me ? (busy ? 'Confirm each step in your wallet…' : 'Publish and open the book') : 'Connect a wallet to issue'}
        </button>
        {emailGate.dialog}
        {progress.length > 0 && <div data-progress><Steps items={progress.map((p, i) => ({ label: p, state: i < progress.length - 1 || p === 'Book open.' ? 'done' : error ? 'err' : 'now' }))} /></div>}
        {error && <div className="notice err" role="alert">{error}</div>}
        <details className="adv">
          <summary>Advanced: roles, steps and contracts</summary>
          <div className="adv-body xs muted">
            <p>Your wallet holds {plan.heldPools.join(', ')}{plan.openPools.length ? `; ${plan.openPools.join(', ')} is open to anyone` : ''}.</p>
            <p>Runs: {all.map(s => s.name).join(' → ')}.</p>
            {chain && <p>Engine {short(chain.cfg.engine)}{chain.cfg.engine === zeroAddress ? ' (not deployed)' : ''} on {chain.cfg.name} · {chain.cfg.cre ? 'reports by Chainlink CRE' : 'reports by the fallback keeper'}{chain.cfg.explorer ? <> · <a href={`${chain.cfg.explorer}/address/${chain.cfg.engine}`} target="_blank" rel="noreferrer">view on explorer</a></> : ''}</p>}
          </div>
        </details>
      </div>
    </>
  );
}

export type Stage = 'design' | 'validate' | 'payoff' | 'template' | 'issue';
