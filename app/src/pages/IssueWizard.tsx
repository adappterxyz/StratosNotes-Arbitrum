/**
 * Issue, guided. Three ways in, all leading to the same steps (Product → Terms → Schedule → Collateral → Review &
 * issue): start from a ready-made note (its terms filled in, opened at the schedule), build your own from a note
 * type, or describe it to the AI. Each step asks only what it needs, with defaults; the rest sits under "More
 * options". The review spells out what the issuer commits to, then the same issue panel the studio uses publishes
 * the note; it can also be saved as a ready-made note. The BPMN canvas is the studio (/issue/advanced).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowLeftRight, ArrowRight, Check, Flame, Layers, Repeat, ShieldCheck, Snowflake, Workflow,
} from 'lucide-react';
import {
  check, COLLATERAL_SYMBOLS, collateralTokenOf, compileTemplate, DEFAULT_HAIRCUT, deliverableToken, economicsOf, EXAMPLE_PRODUCTS, FEEDS, HOME_CHAIN,
  instantiateProduct, MAX_COLLATERAL, MAX_GRACE_DAYS, MAX_UNDERLYINGS, NOTE_CHAINS, noteChainOf, parseBpmn, PRODUCT_LABELS, productUses, UNPRICED_STOCKS,
  validateProductParams, type CollateralSymbol, type DefaultRule, type NoteChain, type ProductParams, type ProductType,
} from '@sn/core';
import PayoffChart from '../components/PayoffChart';
import { IssuePanel, TemplatePanel, type Built, type DocInfo, type IssuePreset } from '../components/Stages';
import ReadyMadeList from '../components/issue/ReadyMadeList';
import DescribeIt from '../components/issue/DescribeIt';
import { AI_DRAFT_KEY, exampleOf, kindOf, loadAiReading, readyMade, saveAiReading, type AiReading, type NoteKind, type ReadyMade } from '../lib/readymade';
import { Asset, AssetIcon, AssetStack } from '../components/AssetIcon';
import { PREFERRED_CHAIN, useChains } from '../lib/chains';
import { fmtMoney, lockedAsset } from '../lib/format';

type Kind = NoteKind;
const PRODUCTS: Array<{ kind: Kind; icon: ReactNode; title: string; line: string }> = [
  { kind: 'fcn', icon: <Repeat />, title: 'Fixed coupon note', line: 'Steady income: the same coupon every period.' },
  { kind: 'reverse-convertible', icon: <ArrowLeftRight />, title: 'Reverse convertible', line: 'A higher coupon; may pay back in stock.' },
  { kind: 'phoenix', icon: <Flame />, title: 'Phoenix', line: 'Coupons while the price stays above a barrier, with memory.' },
  { kind: 'snowball', icon: <Snowflake />, title: 'Snowball', line: 'The payout grows each period until it is called.' },
  { kind: 'ppn', icon: <ShieldCheck />, title: 'Principal-protected', line: 'Money back at maturity, plus a share of the upside.' },
  { kind: 'worst-of', icon: <Layers />, title: 'Worst-of', line: 'Any of these on a basket: the weakest asset decides.' },
];
const STEPS = ['Product', 'Terms', 'Schedule', 'Collateral', 'Review & issue'] as const;

const start = exampleOf;

/** The recorded demo's note (?product=reverse-convertible&demo=tsla). */
const DEMO_TSLA: ProductParams = {
  ...EXAMPLE_PRODUCTS['reverse-convertible'], name: 'TSLA Reverse Convertible', underlyings: [FEEDS.TSLA], settlement: 'cash',
  issuePricePct: 100, observations: 2, couponRatePct: 2.5, knockInBarrierPct: 70,
  collateralChain: 'robinhood', collateral: [{ symbol: 'TSLA', haircutPct: 60 }], collateralRatioPct: 100,
  defaultRule: 'cap-at-owed', payouts: 'claim',
};

function Num({ id, label, value, onChange, hint, suffix, step = 'any', min }: { id: string; label: string; value: number | undefined; onChange: (v: number) => void; hint?: string; suffix?: string; step?: string; min?: number }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="with-suffix">
        <input id={id} type="number" step={step} min={min} value={value ?? ''} onChange={e => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
        {suffix && <span className="suffix">{suffix}</span>}
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export default function IssueWizard() {
  const [search, setSearch] = useSearchParams();
  const nav = useNavigate();
  const { config } = useChains();
  // Where you are lives in the address (?product=…&step=…, and ?ready=… when started from a ready-made note or the
  // AI), so the browser's Back button walks back through the steps and then to the chooser, and a link reopens the
  // same step.
  const linked = search.get('product') as Kind | null;
  const ready = search.get('ready');
  const kind: Kind | null = linked && (linked === 'worst-of' || EXAMPLE_PRODUCTS[linked as ProductType]) ? linked : null;
  const step = kind ? Math.min(4, Math.max(0, Number(search.get('step')) || 0)) : 0;
  const key = kind ? (ready ? `r:${ready}` : `k:${kind}`) : null;
  // ?demo=tsla: the recorded demo's terms, every field filled in (a TSLA reverse convertible on Arbitrum, collateral TSLA
  // locked on Robinhood Chain, a minutes-apart schedule): the presenter only clicks Continue and signs.
  const demoTsla = kind === 'reverse-convertible' && search.get('demo') === 'tsla';
  // What can be filled in at once (a note type, a built-in, the AI's reading); a saved note loads in the effect below.
  const [init] = useState(() => {
    const hit = kind && ready && ready !== 'ai' ? readyMade(ready) : null;
    const ai = kind && ready === 'ai' ? loadAiReading() : null;
    if (hit && !(hit instanceof Promise)) return { p: hit.params, from: hit, ai, shown: key };
    if (ai) return { p: ai.params, from: null, ai, shown: key };
    if (demoTsla) return { p: DEMO_TSLA, from: null, ai: null, shown: key };
    return { p: start(kind ?? 'phoenix'), from: null, ai: null, shown: kind && !ready ? key : null };
  });
  const [p, setP] = useState<ProductParams>(init.p);
  const [from, setFrom] = useState<ReadyMade | null>(init.from); // the ready-made note it started from
  const [aiNotes, setAiNotes] = useState<string[]>(init.ai?.notes ?? []);
  const [shown, setShown] = useState<string | null>(init.shown); // the key whose terms are in p
  const [lost, setLost] = useState('');
  // The network is part of the note's terms (`chain`): it decides which real tokens it delivers and takes as
  // collateral. Arbitrum Sepolia, the default, is left implicit so its definitions stay as they were.
  const defaultChain = config.chains.find(c => c.key === PREFERRED_CHAIN)?.key ?? config.chains[0]?.key ?? '';
  const chainKey = p.chain && config.chains.some(c => c.key === p.chain) ? p.chain : defaultChain;
  const [size, setSize] = useState(demoTsla ? 20 : init.ai?.schedule?.size ?? 10_000);
  const [strikeIn, setStrikeIn] = useState(5);
  const [every, setEvery] = useState<{ n: number; unit: 'minutes' | 'days' | 'months' }>(init.ai?.schedule ? { n: init.ai.schedule.every, unit: init.ai.schedule.unit } : { n: 3, unit: 'minutes' });
  const applyAi = (r: AiReading) => {
    setP(r.params); setFrom(null); setAiNotes(r.notes ?? []);
    if (r.schedule) { setEvery({ n: r.schedule.every, unit: r.schedule.unit }); if (r.schedule.size) setSize(r.schedule.size); }
  };
  useEffect(() => {
    // Arriving somewhere else (a link, or Back/Forward to the chooser and out again) loads what that address names:
    // a note type's defaults, a ready-made note's terms, or what the AI read.
    if (!key || key === shown) return;
    let live = true;
    setLost('');
    if (!ready) { setP(start(kind!)); setFrom(null); setAiNotes([]); setShown(key); return; }
    if (ready === 'ai') {
      const r = loadAiReading();
      if (r) { applyAi(r); setShown(key); } else setLost('What the AI read is no longer here: describe the note again.');
      return;
    }
    const hit = readyMade(ready);
    const use = (r: ReadyMade | null) => {
      if (!live) return;
      if (!r) { setLost('That ready-made note could not be found.'); return; }
      if (r.custom) { nav(`/issue/advanced?template=${r.id}`, { replace: true }); return; }
      setP(r.params); setFrom(r); setAiNotes([]); setShown(key);
    };
    if (hit instanceof Promise) hit.then(use); else use(hit);
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (k: Kind | null, s = 0) => setSearch(k ? { ...(ready ? { ready } : {}), product: k, step: String(s) } : {});
  const setStep = (s: number) => go(kind, s);
  const [timing, setTiming] = useState<{ lag: number; grace: number } | null>(demoTsla ? { lag: 60, grace: 120 } : null);
  const set = (patch: Partial<ProductParams>) => setP(prev => ({ ...prev, ...patch }));
  /** Another network: its own tokens, so collateral it doesn't have is dropped (the stablecoin always stays). */
  const setChainKey = (k: string) => setP(prev => {
    const chain = (NOTE_CHAINS as readonly string[]).includes(k) && k !== HOME_CHAIN ? k as NoteChain : undefined;
    const next: ProductParams = { ...prev, chain, collateralChain: chain ? undefined : prev.collateralChain };
    const kept = economicsOf(prev).collateral.filter(c => !!collateralTokenOf(next, c.symbol));
    return { ...next, collateral: kept.length ? kept : [{ symbol: 'USD', haircutPct: 100 }] };
  });

  useEffect(() => { window.scrollTo({ top: 0 }); }, [step, kind]);
  // What the issue panel publishes: the product's workflow, compiled as the engine will run it.
  const built = useMemo<Built | null>(() => {
    if (step !== 4 || validateProductParams(p).length) return null;
    try {
      const prod = instantiateProduct(p);
      const ir = parseBpmn(prod.bpmnXml, prod.assets);
      if (check(ir).errors.length) return null;
      return { ir, c: compileTemplate({ product: p }), source: { product: p } };
    } catch { return null; }
  }, [step, p]); // eslint-disable-line react-hooks/exhaustive-deps

  // A template link belongs to the studio.
  if (search.get('template')) return <Navigate to={`/issue/advanced?${search.toString()}`} replace />;

  const choose = (k: Kind) => { setP(start(k)); setFrom(null); setAiNotes([]); setShown(`k:${k}`); setSearch({ product: k, step: '0' }); };
  const pick = (r: ReadyMade) => { setP(r.params); setFrom(r); setAiNotes([]); setShown(`r:${r.id}`); setSearch({ ready: r.id, product: kindOf(r.params), step: '2' }); };
  const fromAi = (r: AiReading) => { saveAiReading(r); applyAi(r); setShown('r:ai'); setSearch({ ready: 'ai', product: kindOf(r.params), step: '1' }); };
  const aiWorkflow = (xml: string) => { try { sessionStorage.setItem(AI_DRAFT_KEY, xml); } catch { /* storage blocked */ } nav('/issue/advanced?draft=ai&ai=1'); };
  // The studio opens these exact terms (?params=), or the saved note itself when they are unchanged.
  const customise = () => nav(from && !from.custom && JSON.stringify(from.params) === JSON.stringify(p) && from.author
    ? `/issue/advanced?template=${from.id}` : `/issue/advanced?params=${encodeURIComponent(JSON.stringify(p))}`);
  const eco = economicsOf(p);
  const use = productUses(p.productType);
  const errors = validateProductParams(p);
  const syms = p.underlyings.map(u => u.symbol);
  const remote = p.collateralChain === 'robinhood';
  const chainCfg = config.chains.find(c => c.key === chainKey);
  const onHome = noteChainOf(p) === HOME_CHAIN;
  const colToken = (c: CollateralSymbol) => collateralTokenOf(p, c)?.token ?? null;
  /** A receipt (TSLA.rh…) is offered only when the chain's config lists it (the gateway registered it). */
  const colLive = (tok: string | null) => !!tok && (!tok.endsWith('.rh') || !!chainCfg?.tokens?.[tok]);
  const delivered = (s: string) => deliverableToken(p, s)?.token ?? null;
  const physicalOk = syms.every(s => !!delivered(s));
  const colSyms = eco.collateral.map(c => c.symbol);
  const sym = config.chains.find(c => c.key === chainKey)?.stablecoin.symbol ?? 'USDG';

  // Payment timing: per issuance. A schedule minutes apart (a demo) gets seconds; a real one, days.
  const stepSec = every.unit === 'minutes' ? every.n * 60 : every.unit === 'days' ? every.n * 86400 : every.n * 30 * 86400;
  const demo = every.unit === 'minutes';
  const t = timing ?? (demo ? { lag: Math.min(30, Math.floor(stepSec / 4)), grace: Math.min(60, Math.floor(stepSec / 3)) } : { lag: eco.settlementLagDays * 86400, grace: eco.gracePeriodDays * 86400 });
  const timingBad = t.lag + t.grace > stepSec ? 'The payment date plus grace must fall before the next observation.' : t.grace > MAX_GRACE_DAYS * 86400 ? `Grace is at most ${MAX_GRACE_DAYS} days.` : '';
  const strikeAt = Math.floor(Date.now() / 60000) * 60 + strikeIn * 60;
  const dateOf = (k: number) => {
    if (every.unit === 'months') { const d = new Date(strikeAt * 1000); d.setUTCMonth(d.getUTCMonth() + every.n * k); return Math.floor(d.getTime() / 1000); }
    return strikeAt + k * every.n * (every.unit === 'days' ? 86400 : 60);
  };
  const fmtT = (s: number) => (demo ? new Date(s * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date(s * 1000).toLocaleDateString([], { dateStyle: 'medium' }));
  const dur = (s: number) => (demo ? `${s}s` : `${+(s / 86400).toFixed(2)} days`);

  const toggleUnd = (k: keyof typeof FEEDS) => {
    if (syms.includes(k)) { if (syms.length > 1) set({ underlyings: p.underlyings.filter(u => u.symbol !== k) }); }
    else if (kind !== 'worst-of') set({ underlyings: [FEEDS[k]] });
    else if (syms.length < MAX_UNDERLYINGS) set({ underlyings: [...p.underlyings, FEEDS[k]] });
  };
  /** The collateral that stays pledgeable under other terms (the stablecoin when nothing does). */
  const keepCol = (q: ProductParams) => {
    const kept = eco.collateral.filter(c => !!collateralTokenOf(q, c.symbol));
    return kept.length ? kept : [{ symbol: 'USD' as const, haircutPct: 100 }];
  };
  const toggleCol = (c: CollateralSymbol) => {
    if (colSyms.includes(c)) { if (colSyms.length > 1) set({ collateral: eco.collateral.filter(x => x.symbol !== c) }); }
    else if (colSyms.length < MAX_COLLATERAL) set({ collateral: [...eco.collateral, { symbol: c, haircutPct: DEFAULT_HAIRCUT[c] }] });
  };

  const doc: DocInfo = { name: p.name, origin: 'product', basis: p, edited: false, template: from?.summary && JSON.stringify(from.params) === JSON.stringify(p) ? from.summary : undefined };
  const preset: IssuePreset = { chainKey, size, strikeIn, every, ratioPct: eco.collateralRatioPct, haircuts: Object.fromEntries(eco.collateral.map(c => [c.symbol, c.haircutPct])), timing: t };

  // ---- the chooser: three ways in --------------------------------------------------------------------------------
  if (!kind) {
    return (
      <main className="page iw">
        <div className="page-head">
          <div><h1>Issue a note</h1><p>Start from a ready-made note, build your own, or describe it. Either way you set the schedule and collateral one step at a time, then review everything before it goes on-chain.</p></div>
        </div>
        <section className="iw-door" aria-labelledby="door-ready">
          <div className="iw-door-h"><h2 id="door-ready">Start from a ready-made note</h2><span className="small muted">Terms filled in: pick the schedule and collateral, then issue.</span></div>
          <ReadyMadeList onPick={pick} />
        </section>
        <section className="iw-door" aria-labelledby="door-own">
          <div className="iw-door-h"><h2 id="door-own">Build your own</h2><span className="small muted">Pick a note type and set every term yourself.</span></div>
          <div className="iw-grid">
            {PRODUCTS.map(x => (
              <button key={x.kind} className="iw-card" data-product={x.kind} onClick={() => choose(x.kind)}>
                <span className="iw-ic" aria-hidden="true">{x.icon}</span>
                <span className="iw-t">{x.title}</span>
                <span className="iw-d">{x.line}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="iw-door" aria-labelledby="door-ai">
          <div className="iw-door-h"><h2 id="door-ai">Describe it</h2><span className="small muted">The AI fills in the note type and terms; anything missing comes back as a question.</span></div>
          <DescribeIt onProduct={fromAi} onWorkflow={aiWorkflow} />
        </section>
        <p className="iw-adv"><Link to="/issue/advanced"><Workflow className="i" />Advanced: edit the workflow on the BPMN canvas</Link></p>
      </main>
    );
  }

  if (key !== shown) {
    return (
      <main className="page iw">
        <nav className="crumbs" aria-label="Breadcrumb"><Link to="/issue">Issue</Link></nav>
        {lost ? <div className="notice warn" role="alert">{lost} <Link to="/issue">Back to Issue</Link></div> : <p className="muted">Loading the ready-made note…</p>}
      </main>
    );
  }

  const canNext = step === 1 || step === 3 ? errors.length === 0 && (step !== 3 || !timingBad) : step === 2 ? size > 0 && strikeIn >= 2 && every.n > 0 : true;

  return (
    <main className="page iw">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/issue">Issue</Link><span aria-hidden="true">/</span>
        <span>{from ? from.name : PRODUCTS.find(x => x.kind === kind)?.title ?? PRODUCT_LABELS[p.productType]}</span><span aria-hidden="true">/</span>
        <span aria-current="page">{STEPS[step]}</span>
      </nav>
      <ol className="iw-progress" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i < step ? 'done' : i === step ? 'now' : ''} aria-current={i === step ? 'step' : undefined}>
            <button disabled={i > step} onClick={() => setStep(i)}><span className="n">{i < step ? <Check className="i" /> : i + 1}</span>{s}</button>
          </li>
        ))}
      </ol>

      {from && step < 4 && <div className="notice info iw-from">Started from the ready-made note <strong>{from.name}</strong>{from.author ? '' : ' by notes.markets'}: its terms are filled in. Change anything on the earlier steps.</div>}
      {ready === 'ai' && step < 4 && <div className="notice info iw-from">Filled in by the AI from your description. Check every term{aiNotes.length ? ':' : '.'}{aiNotes.length > 0 && <ul>{aiNotes.map(n => <li key={n}>{n}</li>)}</ul>}</div>}
      <div className={`iw-body ${step === 1 || step === 4 ? 'with-side' : ''}`}>
        <section className="card iw-step">
          {step === 0 && (
            <>
              <h2><span className="iw-ic sm" aria-hidden="true">{PRODUCTS.find(x => x.kind === kind)?.icon}</span>{PRODUCT_LABELS[p.productType]}{kind === 'worst-of' ? ' on a basket' : ''}</h2>
              <div className="field">
                <span className="lbl">{kind === 'worst-of' ? `Underlyings (2–${MAX_UNDERLYINGS}): the weakest decides` : 'Underlying'}</span>
                <div className="row iw-unds" role="group" aria-label="Underlyings">
                  {(Object.keys(FEEDS) as Array<keyof typeof FEEDS>).map(k => (
                    <button key={k} type="button" className={`chip ${syms.includes(k) ? 'on' : ''}`} aria-pressed={syms.includes(k)} onClick={() => toggleUnd(k)}>
                      <AssetIcon sym={k} size={18} />{k}
                    </button>
                  ))}
                  {UNPRICED_STOCKS.map(k => (
                    <button key={k} type="button" className="chip" disabled title={`${k}: a Robinhood Chain stock token you can hold, with no Chainlink price yet`}>
                      <AssetIcon sym={k} size={18} />{k}
                    </button>
                  ))}
                </div>
                <span className="hint">Fixed by Chainlink on each asset's own chain: crypto on Ethereum, stocks on Robinhood Chain. {UNPRICED_STOCKS.join(', ')}: held on Robinhood Chain, no Chainlink price yet.</span>
              </div>
              {config.chains.length > 1 && (
                <div className="field">
                  <label htmlFor="iw-chain">Network</label>
                  <select id="iw-chain" value={chainKey} onChange={e => setChainKey(e.target.value)}>
                    {config.chains.map(c => <option key={c.key} value={c.key}>{c.name}{c.key === 'robinhood-testnet' ? ' (asset chain)' : ''}</option>)}
                  </select>
                  <span className="hint">{onHome
                    ? 'Delivers and takes WETH; stocks and BTC settle in cash here (stocks stay on Robinhood Chain).'
                    : 'Delivers and takes Robinhood Chain\'s own stock tokens (TSLA, AMZN, AMD, PLTR) and WETH.'}</span>
                </div>
              )}
              {kind === 'worst-of' && (
                <div className="field">
                  <label htmlFor="iw-base">Payoff</label>
                  <select id="iw-base" value={p.productType} onChange={e => set({ ...EXAMPLE_PRODUCTS[e.target.value as ProductType], name: p.name, underlyings: p.underlyings, chain: p.chain, collateralChain: p.collateralChain })}>
                    {(Object.keys(PRODUCT_LABELS) as ProductType[]).map(x => <option key={x} value={x}>{PRODUCT_LABELS[x]}</option>)}
                  </select>
                </div>
              )}
              {use.knockIn && (
                <div className="field">
                  <span className="lbl">If the price falls through the knock-in barrier, holders get</span>
                  <div className="seg" role="radiogroup" aria-label="Settlement">
                    <button role="radio" aria-checked={(p.settlement ?? 'cash') === 'cash'} className={(p.settlement ?? 'cash') === 'cash' ? 'active' : ''} onClick={() => set({ settlement: 'cash' })}><Asset sym="USDG" size={16} />Cash</button>
                    <button role="radio" aria-checked={p.settlement === 'physical'} className={p.settlement === 'physical' ? 'active' : ''} disabled={!physicalOk && p.settlement !== 'physical'} title={physicalOk ? undefined : `No ${syms.filter(s => !delivered(s)).join(', ')} token on ${chainCfg?.name ?? 'this network'}`} onClick={() => set({ settlement: 'physical' })}><AssetStack syms={syms} size={16} label={false} />The asset itself</button>
                  </div>
                  <span className="hint">{physicalOk
                    ? `The asset itself: ${syms.map(s => delivered(s)).join(', ')} on ${chainCfg?.name ?? 'the note\'s network'}.`
                    : `No ${syms.filter(s => !delivered(s)).join(', ')} token on ${chainCfg?.name ?? 'this network'}: cash only.`}</span>
                  {p.settlement === 'physical' && !physicalOk && <div className="notice warn">This network has no token to deliver for {syms.filter(s => !delivered(s)).join(', ')}: settle in cash, or pick another network or underlying.</div>}
                </div>
              )}
              <div className="field">
                <label htmlFor="iw-name">Name</label>
                <input id="iw-name" value={p.name} onChange={e => set({ name: e.target.value })} />
              </div>
              <details className="adv">
                <summary>More options</summary>
                <div className="adv-body form-grid">
                  <Num id="iw-price" label="Issue price" suffix="%" value={p.issuePricePct} onChange={v => set({ issuePricePct: v })} />
                </div>
              </details>
            </>
          )}

          {step === 1 && (
            <>
              <h2>Terms</h2>
              <div className="form-grid">
                <Num id="iw-obs" label="Observations" value={p.observations} step="1" min={1} onChange={v => set({ observations: v, ...(p.autocallFromPeriod && p.autocallFromPeriod > v ? { autocallFromPeriod: 1 } : {}) })} hint="The last one is maturity." />
                {use.coupon && <Num id="iw-cpn" label={p.productType === 'snowball' ? 'Coupon added each period' : 'Coupon each period'} suffix="%" value={p.couponRatePct} onChange={v => set({ couponRatePct: v })} hint="Paid in USDG." />}
                {use.couponBarrier && <Num id="iw-cb" label="Coupon barrier (of strike)" suffix="%" value={p.couponBarrierPct} onChange={v => set({ couponBarrierPct: v })} />}
                {use.autocall && <Num id="iw-ac" label="Early repayment at (of strike)" suffix="%" value={p.autocallLevelPct} onChange={v => set({ autocallLevelPct: v })} />}
                {use.knockIn && <Num id="iw-ki" label="Knock-in barrier (of strike)" suffix="%" value={p.knockInBarrierPct} onChange={v => set({ knockInBarrierPct: v })} hint={p.settlement === 'physical' ? 'Below it at maturity: the stock.' : 'Below it at maturity: final ÷ strike in USDG.'} />}
                {use.protection && <Num id="iw-prot" label="Protected" suffix="%" value={p.protectionPct} onChange={v => set({ protectionPct: v })} />}
                {use.protection && <Num id="iw-part" label="Share of the upside" suffix="%" value={p.participationPct} onChange={v => set({ participationPct: v })} />}
              </div>
              {(use.couponBarrier || use.autocall) && (
                <details className="adv">
                  <summary>More options</summary>
                  <div className="adv-body form-grid">
                    {use.couponBarrier && (
                      <div className="field"><label htmlFor="iw-mem">Missed coupons paid later (memory)</label>
                        <select id="iw-mem" value={p.memory ? 'yes' : 'no'} onChange={e => set({ memory: e.target.value === 'yes' })}><option value="yes">Yes</option><option value="no">No</option></select>
                      </div>
                    )}
                    {use.autocall && <Num id="iw-acf" label="Early repayment from observation" step="1" min={1} value={p.autocallFromPeriod ?? 1} onChange={v => set({ autocallFromPeriod: v })} />}
                  </div>
                </details>
              )}
              {errors.length > 0 && <ul className="issues">{errors.map(e => <li key={e} className="err">{e}</li>)}</ul>}
            </>
          )}

          {step === 2 && (
            <>
              <h2>Schedule</h2>
              <div className="form-grid">
                <Num id="is-size" label="Size" suffix={sym} value={size} min={1} onChange={v => setSize(v)} hint="Units on offer, one unit per 1 USDG of face value." />
                <Num id="is-strike" label="Book closes in" suffix="minutes" value={strikeIn} min={2} onChange={v => setStrikeIn(Math.max(2, v || 2))} hint="The strike is fixed then." />
                <div className="field">
                  <label htmlFor="is-every">Observe every</label>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <input id="is-every" type="number" min={1} value={every.n} onChange={e => { setEvery({ ...every, n: Number(e.target.value) || 1 }); setTiming(null); }} style={{ width: 64 }} />
                    <select aria-label="Interval unit" value={every.unit} onChange={e => { setEvery({ ...every, unit: e.target.value as typeof every.unit }); setTiming(null); }}>
                      <option value="minutes">minutes (demo)</option><option value="days">days</option><option value="months">months</option>
                    </select>
                  </div>
                </div>
              </div>
              <p className="small muted">On {chainCfg?.name ?? chainKey} (set on the first step). Strike {fmtT(strikeAt)}, then {Array.from({ length: p.observations }, (_, i) => fmtT(dateOf(i + 1))).join(' · ')}.{demo ? ' Minutes apart runs a whole lifecycle while you watch.' : ''}</p>
            </>
          )}

          {step === 3 && (
            <>
              <h2>Collateral</h2>
              <p className="small muted">You lock collateral for the note's whole life. Investors' USDG comes to you; if you miss a payment, holders take what they're owed from the collateral.</p>
              {onHome && (
                <div className="field">
                  <span className="lbl">Held on</span>
                  <div className="seg" role="radiogroup" aria-label="Collateral held on">
                    <button role="radio" aria-checked={!remote} className={!remote ? 'active' : ''} onClick={() => set({ collateralChain: 'note', collateral: keepCol({ ...p, collateralChain: 'note' }) })}>The note's chain</button>
                    <button role="radio" aria-checked={remote} className={remote ? 'active' : ''} onClick={() => set({ collateralChain: 'robinhood', collateral: keepCol({ ...p, collateralChain: 'robinhood' }) })}>
                      <img src={`${import.meta.env.BASE_URL}assets/robinhood-feather.svg`} alt="" width={14} height={14} />Robinhood Chain
                    </button>
                  </div>
                  <span className="hint">{remote
                    ? 'USDG, TSLA, AMZN, AMD or PLTR stay locked in the vault on Robinhood Chain; Chainlink CCIP tells the note (about 15–25 minutes), and the note sends them back there when it lets them go. Nothing is bridged.'
                    : 'USDG or WETH, pledged into the note on Arbitrum. To pledge TSLA, AMZN, AMD or PLTR, lock them on Robinhood Chain.'}</span>
                </div>
              )}
              <div className="field">
                <span className="lbl">Assets you lock (up to {MAX_COLLATERAL})</span>
                <div className="row iw-unds" role="group" aria-label="Collateral">
                  {COLLATERAL_SYMBOLS.filter(c => !!colToken(c)).map(c => {
                    const tok = colToken(c)!;
                    const live = colLive(tok);
                    return (
                      <button key={c} type="button" className={`chip ${colSyms.includes(c) ? 'on' : ''}`} aria-pressed={colSyms.includes(c)} onClick={() => toggleCol(c)}
                        disabled={!colSyms.includes(c) && (colSyms.length >= MAX_COLLATERAL || !live)} title={live ? undefined : `${tok} is not registered on the gateway yet`}>
                        <AssetIcon sym={tok} size={18} />{lockedAsset(tok)}
                      </button>
                    );
                  })}
                  {(remote || !onHome) && UNPRICED_STOCKS.map(k => (
                    <button key={k} type="button" className="chip" disabled title={`${k}: held on Robinhood Chain, no Chainlink price yet`}><AssetIcon sym={k} size={18} />{k}</button>
                  ))}
                </div>
                {(remote || !onHome) && <span className="hint">{UNPRICED_STOCKS.join(', ')}: held on Robinhood Chain, no Chainlink price yet, so they can't be pledged.</span>}
              </div>
              <div className="form-grid">
                <Num id="iw-ratio" label="Collateral ratio (of size)" suffix="%" value={eco.collateralRatioPct} onChange={v => set({ collateralRatioPct: v })} hint={`${fmtMoney((eco.collateralRatioPct / 100) * size)} ${sym} of value required.`} />
                <Num id="is-lag" label={`Pay holders within (${demo ? 'seconds' : 'days'})`} value={demo ? t.lag : t.lag / 86400} min={0} onChange={v => setTiming({ ...t, lag: Math.max(0, v || 0) * (demo ? 1 : 86400) })} hint="After each observation." />
                <Num id="is-grace" label={`Grace period (${demo ? 'seconds' : 'days'})`} value={demo ? t.grace : t.grace / 86400} min={0} onChange={v => setTiming({ ...t, grace: Math.max(0, v || 0) * (demo ? 1 : 86400) })} hint={`Up to ${MAX_GRACE_DAYS} days, then default.`} />
              </div>
              {timingBad && <div className="notice warn">{timingBad}</div>}
              <details className="adv">
                <summary>More options: haircuts, the default rule and how holders get paid</summary>
                <div className="adv-body form-grid">
                  {eco.collateral.filter(c => c.symbol !== 'USD').map(c => (
                    <Num key={c.symbol} id={`iw-hc-${c.symbol}`} label={`${lockedAsset(colToken(c.symbol) ?? c.symbol)} counted at (of value)`} suffix="%" value={c.haircutPct} onChange={v => set({ collateral: eco.collateral.map(x => (x.symbol === c.symbol ? { ...x, haircutPct: v } : x)) })} />
                  ))}
                  <div className="field">
                    <label htmlFor="iw-default">On a default, holders get</label>
                    <select id="iw-default" value={eco.defaultRule} onChange={e => set({ defaultRule: e.target.value as DefaultRule })}>
                      <option value="cap-at-owed">What they're owed; the rest back to you</option>
                      <option value="all-to-holders">Everything in escrow</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="iw-payouts">Holders get their payouts</label>
                    <select id="iw-payouts" value={p.payouts ?? 'claim'} onChange={e => set({ payouts: e.target.value === 'push' ? 'push' : undefined })}>
                      <option value="claim">By claiming them, any time (they pay their own gas)</option>
                      <option value="push">Sent to their wallets automatically (you pay the gas)</option>
                    </select>
                    <span className="hint">{p.payouts === 'push' ? 'Your bot sends every payment to every holder: about 55,000 gas per holder per payment, paid by you.' : 'Payments wait in the note until each holder claims; one claim collects everything, with a receipt.'}</span>
                  </div>
                </div>
              </details>
              {errors.length > 0 && <ul className="issues">{errors.map(e => <li key={e} className="err">{e}</li>)}</ul>}
            </>
          )}

          {step === 4 && (
            <>
              <h2>Review & issue</h2>
              <dl className="iw-review">
                <dt>Note</dt><dd><strong>{p.name}</strong> · {PRODUCT_LABELS[p.productType]} on <AssetStack syms={syms} size={16} /></dd>
                <dt>Size</dt><dd>{fmtMoney(size, 0)} {sym}, book open until {fmtT(strikeAt)}; {p.observations} observations every {every.n} {every.unit}.</dd>
                <dt>Investors get</dt><dd>{p.couponRatePct ? `${p.couponRatePct}% ${p.productType === 'snowball' ? 'added each period, paid when called' : 'coupon each period'} in USDG${p.couponBarrierPct ? ` while the worst price is at least ${p.couponBarrierPct}% of strike` : ''}. ` : ''}{p.autocallLevelPct ? `Repaid early at ${p.autocallLevelPct}% or more. ` : ''}{p.protectionPct ? `${p.protectionPct}% back at maturity plus ${p.participationPct}% of any rise. ` : ''}{p.knockInBarrierPct ? `Below ${p.knockInBarrierPct}% at maturity: ${p.settlement === 'physical' ? 'the stock instead of cash' : 'final ÷ strike in USDG'}.` : ''}</dd>
                <dt>Payouts</dt><dd>{p.payouts === 'push' ? 'Paid to holders\' wallets automatically; you cover the gas.' : 'Holders claim any time from their portfolio; they pay their own gas.'}</dd>
                <dt>You commit to</dt>
                <dd>
                  <ul className="iw-list">
                    <li>Lock {eco.collateral.map(c => lockedAsset(colToken(c.symbol) ?? c.symbol)).join(' + ')} worth at least {eco.collateralRatioPct}% of what's sold{remote ? ', on Robinhood Chain' : ''}, until the last payment.</li>
                    <li>Fund each payment within {dur(t.lag)} of its observation; a {dur(t.grace)} grace period follows.</li>
                    <li>If a payment is still missing, holders take {eco.defaultRule === 'cap-at-owed' ? "what they're owed" : 'everything in escrow'} from the collateral.</li>
                    {p.payouts === 'push' && <li>Send each payment to every holder's wallet and pay the gas (run the issuer bot).</li>}
                  </ul>
                </dd>
              </dl>
              {built ? <IssuePanel key={JSON.stringify(preset) + p.name} doc={doc} built={built} preset={preset} compact />
                : <div className="notice err">This note doesn't compile: go back and check its terms.</div>}
              {built && (
                <details className="adv iw-save">
                  <summary>Save as a ready-made note</summary>
                  <div className="adv-body"><TemplatePanel key={p.name} doc={doc} build={async () => built} onSaved={() => {}} bare /></div>
                </details>
              )}
            </>
          )}

          <div className="iw-nav">
            {step > 0
              ? <button className="btn" onClick={() => setStep(step - 1)}><ArrowLeft className="i" />Back</button>
              : <button className="btn" onClick={() => go(null)}><ArrowLeft className="i" />Back to Issue</button>}
            {step < 4 && <button className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Continue: {STEPS[step + 1]}<ArrowRight className="i" /></button>}
            {step === 4 && <button className="btn" onClick={customise}><Workflow className="i" />Customise the workflow</button>}
          </div>
        </section>

        {(step === 1 || step === 4) && (
          <aside className="card iw-side" aria-label="Payoff">
            <span className="label">Payout per 100 at maturity</span>
            {errors.length ? <p className="xs muted">Fix the terms to see the payoff.</p> : <PayoffChart params={p} />}
          </aside>
        )}
      </div>
    </main>
  );
}
