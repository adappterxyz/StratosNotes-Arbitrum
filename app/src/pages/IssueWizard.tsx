/**
 * Issue, guided: pick what to issue, then one step at a time (Product → Terms → Schedule → Collateral → Review &
 * issue). Each step asks only what it needs, with defaults; the rest sits under "More options". The review spells
 * out what the issuer commits to, then the same issue panel the studio uses publishes the note.
 * Templates, the AI and the BPMN canvas live in the studio (/issue/advanced).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowLeftRight, ArrowRight, Check, Flame, Layers, LayoutTemplate, Repeat, ShieldCheck, Snowflake, Sparkles, Workflow,
} from 'lucide-react';
import {
  check, COLLATERAL_SYMBOLS, collateralTokenOf, compileTemplate, DEFAULT_HAIRCUT, economicsOf, EXAMPLE_PRODUCTS, EXAMPLE_WORST_OF, FEEDS,
  instantiateProduct, MAX_COLLATERAL, MAX_GRACE_DAYS, MAX_UNDERLYINGS, parseBpmn, PRODUCT_LABELS, productUses, validateProductParams,
  type CollateralSymbol, type DefaultRule, type ProductParams, type ProductType,
} from '@sn/core';
import PayoffChart from '../components/PayoffChart';
import { IssuePanel, type Built, type DocInfo, type IssuePreset } from '../components/Stages';
import { Asset, AssetIcon, AssetStack } from '../components/AssetIcon';
import { PREFERRED_CHAIN, useChains } from '../lib/chains';
import { fmtMoney } from '../lib/format';

type Kind = ProductType | 'worst-of';
const PRODUCTS: Array<{ kind: Kind; icon: ReactNode; title: string; line: string }> = [
  { kind: 'fcn', icon: <Repeat />, title: 'Fixed coupon note', line: 'Steady income: the same coupon every period.' },
  { kind: 'reverse-convertible', icon: <ArrowLeftRight />, title: 'Reverse convertible', line: 'A higher coupon; may pay back in stock.' },
  { kind: 'phoenix', icon: <Flame />, title: 'Phoenix', line: 'Coupons while the price stays above a barrier, with memory.' },
  { kind: 'snowball', icon: <Snowflake />, title: 'Snowball', line: 'The payout grows each period until it is called.' },
  { kind: 'ppn', icon: <ShieldCheck />, title: 'Principal-protected', line: 'Money back at maturity, plus a share of the upside.' },
  { kind: 'worst-of', icon: <Layers />, title: 'Worst-of', line: 'Any of these on a basket: the weakest asset decides.' },
];
const STEPS = ['Product', 'Terms', 'Schedule', 'Collateral', 'Review & issue'] as const;

const start = (k: Kind): ProductParams => ({ ...(k === 'worst-of' ? EXAMPLE_WORST_OF : EXAMPLE_PRODUCTS[k]), stockTokens: 'robinhood' });

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
  const [search] = useSearchParams();
  const nav = useNavigate();
  const { config } = useChains();
  const linked = search.get('product') as Kind | null;
  const [kind, setKind] = useState<Kind | null>(linked && (linked === 'worst-of' || EXAMPLE_PRODUCTS[linked as ProductType]) ? linked : null);
  const [p, setP] = useState<ProductParams>(() => start(kind ?? 'phoenix'));
  const [step, setStep] = useState(0);
  const [chainKey, setChainKey] = useState(config.chains.find(c => c.key === PREFERRED_CHAIN)?.key ?? config.chains[0]?.key ?? '');
  const [size, setSize] = useState(10_000);
  const [strikeIn, setStrikeIn] = useState(5);
  const [every, setEvery] = useState<{ n: number; unit: 'minutes' | 'days' | 'months' }>({ n: 3, unit: 'minutes' });
  const [timing, setTiming] = useState<{ lag: number; grace: number } | null>(null);
  const set = (patch: Partial<ProductParams>) => setP(prev => ({ ...prev, ...patch }));

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

  const choose = (k: Kind) => { setKind(k); setP(start(k)); setStep(0); };
  const eco = economicsOf(p);
  const use = productUses(p.productType);
  const errors = validateProductParams(p);
  const syms = p.underlyings.map(u => u.symbol);
  const remote = p.collateralChain === 'robinhood';
  const colToken = (c: CollateralSymbol) => (c === 'USD' && !remote ? 'USDG' : collateralTokenOf(p, c)?.token ?? null);
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
  const toggleCol = (c: CollateralSymbol) => {
    if (colSyms.includes(c)) { if (colSyms.length > 1) set({ collateral: eco.collateral.filter(x => x.symbol !== c) }); }
    else if (colSyms.length < MAX_COLLATERAL) set({ collateral: [...eco.collateral, { symbol: c, haircutPct: DEFAULT_HAIRCUT[c] }] });
  };

  const doc: DocInfo = { name: p.name, origin: 'product', basis: p, edited: false };
  const preset: IssuePreset = { chainKey, size, strikeIn, every, ratioPct: eco.collateralRatioPct, haircuts: Object.fromEntries(eco.collateral.map(c => [c.symbol, c.haircutPct])), timing: t };

  // ---- the chooser -----------------------------------------------------------------------------------------------
  if (!kind) {
    return (
      <main className="page iw">
        <div className="page-head">
          <div><h1>What do you want to issue?</h1><p>Pick a note. You'll set its terms, schedule and collateral one step at a time, then review everything before it goes on-chain.</p></div>
        </div>
        <div className="iw-grid">
          {PRODUCTS.map(x => (
            <button key={x.kind} className="iw-card" data-product={x.kind} onClick={() => choose(x.kind)}>
              <span className="iw-ic" aria-hidden="true">{x.icon}</span>
              <span className="iw-t">{x.title}</span>
              <span className="iw-d">{x.line}</span>
            </button>
          ))}
        </div>
        <div className="iw-more">
          <Link to="/issue/advanced#templates" className="iw-card sm"><span className="iw-ic" aria-hidden="true"><LayoutTemplate /></span><span className="iw-t">Templates</span><span className="iw-d">Notes other issuers published.</span></Link>
          <Link to="/issue/advanced?ai=1" className="iw-card sm"><span className="iw-ic" aria-hidden="true"><Sparkles /></span><span className="iw-t">Describe it to the AI</span><span className="iw-d">Paste a term sheet or say what you want.</span></Link>
          <Link to="/issue/advanced" className="iw-card sm"><span className="iw-ic" aria-hidden="true"><Workflow /></span><span className="iw-t">Advanced: BPMN canvas</span><span className="iw-d">Draw or edit the workflow itself.</span></Link>
        </div>
      </main>
    );
  }

  const canNext = step === 1 || step === 3 ? errors.length === 0 && (step !== 3 || !timingBad) : step === 2 ? size > 0 && strikeIn >= 2 && every.n > 0 : true;

  return (
    <main className="page iw">
      <button className="linkish small row" style={{ gap: 4, textDecoration: 'none' }} onClick={() => setKind(null)}><ArrowLeft className="i" />Choose another note</button>
      <ol className="iw-progress" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i < step ? 'done' : i === step ? 'now' : ''} aria-current={i === step ? 'step' : undefined}>
            <button disabled={i > step} onClick={() => setStep(i)}><span className="n">{i < step ? <Check className="i" /> : i + 1}</span>{s}</button>
          </li>
        ))}
      </ol>

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
                </div>
                <span className="hint">Prices from Chainlink: crypto on Ethereum, stocks on Arbitrum One.</span>
              </div>
              {kind === 'worst-of' && (
                <div className="field">
                  <label htmlFor="iw-base">Payoff</label>
                  <select id="iw-base" value={p.productType} onChange={e => set({ ...EXAMPLE_PRODUCTS[e.target.value as ProductType], name: p.name, underlyings: p.underlyings, stockTokens: p.stockTokens })}>
                    {(Object.keys(PRODUCT_LABELS) as ProductType[]).map(x => <option key={x} value={x}>{PRODUCT_LABELS[x]}</option>)}
                  </select>
                </div>
              )}
              {use.knockIn && (
                <div className="field">
                  <span className="lbl">If the price falls through the knock-in barrier, holders get</span>
                  <div className="seg" role="radiogroup" aria-label="Settlement">
                    <button role="radio" aria-checked={(p.settlement ?? 'cash') === 'cash'} className={(p.settlement ?? 'cash') === 'cash' ? 'active' : ''} onClick={() => set({ settlement: 'cash' })}><Asset sym="USDG" size={16} />Cash</button>
                    <button role="radio" aria-checked={p.settlement === 'physical'} className={p.settlement === 'physical' ? 'active' : ''} onClick={() => set({ settlement: 'physical' })}><AssetStack syms={syms} size={16} label={false} />The stock itself</button>
                  </div>
                </div>
              )}
              <div className="field">
                <label htmlFor="iw-name">Name</label>
                <input id="iw-name" value={p.name} onChange={e => set({ name: e.target.value })} />
              </div>
              <details className="adv">
                <summary>More options</summary>
                <div className="adv-body form-grid">
                  <div className="field">
                    <label htmlFor="iw-stock">Stock tokens</label>
                    <select id="iw-stock" value={p.stockTokens ?? 'test'} onChange={e => set({ stockTokens: e.target.value as 'test' | 'robinhood' })}>
                      <option value="robinhood">Robinhood Chain's own (TSLA, AMZN)</option>
                      <option value="test">notes.markets test tokens (tTSLA…)</option>
                    </select>
                  </div>
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
                {config.chains.length > 1 && (
                  <div className="field">
                    <label htmlFor="iw-chain">Network</label>
                    <select id="iw-chain" value={chainKey} onChange={e => setChainKey(e.target.value)}>
                      {config.chains.map(c => <option key={c.key} value={c.key}>{c.name}{c.key === 'robinhood-testnet' ? ' (asset chain)' : ''}</option>)}
                    </select>
                  </div>
                )}
                <Num id="is-size" label="Size" suffix={sym} value={size} min={1} onChange={v => setSize(v)} hint="Units on offer, one unit per 1 USDG of face value." />
                <Num id="is-strike" label="Book closes in" suffix="minutes" value={strikeIn} min={2} onChange={v => setStrikeIn(Math.max(2, v || 2))} hint="The strike is fixed then." />
                <div className="field">
                  <label htmlFor="is-every">Observe every</label>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <input id="is-every" type="number" min={1} value={every.n} onChange={e => { setEvery({ ...every, n: Number(e.target.value) || 1 }); setTiming(null); }} style={{ width: 80 }} />
                    <select aria-label="Interval unit" value={every.unit} onChange={e => { setEvery({ ...every, unit: e.target.value as typeof every.unit }); setTiming(null); }}>
                      <option value="minutes">minutes (demo)</option><option value="days">days</option><option value="months">months</option>
                    </select>
                  </div>
                </div>
              </div>
              <p className="small muted">Strike {fmtT(strikeAt)}, then {Array.from({ length: p.observations }, (_, i) => fmtT(dateOf(i + 1))).join(' · ')}.{demo ? ' Minutes apart runs a whole lifecycle while you watch.' : ''}</p>
            </>
          )}

          {step === 3 && (
            <>
              <h2>Collateral</h2>
              <p className="small muted">You lock collateral for the note's whole life. Investors' USDG comes to you; if you miss a payment, holders take what they're owed from the collateral.</p>
              <div className="field">
                <span className="lbl">Held on</span>
                <div className="seg" role="radiogroup" aria-label="Collateral held on">
                  <button role="radio" aria-checked={!remote} className={!remote ? 'active' : ''} onClick={() => set({ collateralChain: 'note' })}>The note's chain</button>
                  <button role="radio" aria-checked={remote} className={remote ? 'active' : ''} onClick={() => set({ collateralChain: 'robinhood', collateral: (p.collateral ?? eco.collateral).filter(c => ['USD', 'TSLA', 'AMZN'].includes(c.symbol)) })}>
                    <img src={`${import.meta.env.BASE_URL}assets/robinhood-feather.svg`} alt="" width={14} height={14} />Robinhood Chain
                  </button>
                </div>
                {remote && <span className="hint">Locked in place on Robinhood Chain; Chainlink CCIP credits it to the note (about 15–25 minutes). Issue on Arbitrum Sepolia.</span>}
              </div>
              <div className="field">
                <span className="lbl">Assets you lock (up to {MAX_COLLATERAL})</span>
                <div className="row iw-unds" role="group" aria-label="Collateral">
                  {COLLATERAL_SYMBOLS.map(c => {
                    const tok = colToken(c);
                    return (
                      <button key={c} type="button" className={`chip ${colSyms.includes(c) ? 'on' : ''}`} aria-pressed={colSyms.includes(c)} onClick={() => toggleCol(c)} disabled={!colSyms.includes(c) && (colSyms.length >= MAX_COLLATERAL || !tok)}>
                        <AssetIcon sym={tok ?? c} size={18} />{tok ?? c}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="form-grid">
                <Num id="iw-ratio" label="Collateral ratio (of size)" suffix="%" value={eco.collateralRatioPct} onChange={v => set({ collateralRatioPct: v })} hint={`${fmtMoney((eco.collateralRatioPct / 100) * size)} ${sym} of value required.`} />
                <Num id="is-lag" label={`Pay holders within (${demo ? 'seconds' : 'days'})`} value={demo ? t.lag : t.lag / 86400} min={0} onChange={v => setTiming({ ...t, lag: Math.max(0, v || 0) * (demo ? 1 : 86400) })} hint="After each observation." />
                <Num id="is-grace" label={`Grace period (${demo ? 'seconds' : 'days'})`} value={demo ? t.grace : t.grace / 86400} min={0} onChange={v => setTiming({ ...t, grace: Math.max(0, v || 0) * (demo ? 1 : 86400) })} hint={`Up to ${MAX_GRACE_DAYS} days, then default.`} />
              </div>
              {timingBad && <div className="notice warn">{timingBad}</div>}
              <details className="adv">
                <summary>More options: haircuts and the default rule</summary>
                <div className="adv-body form-grid">
                  {eco.collateral.filter(c => c.symbol !== 'USD').map(c => (
                    <Num key={c.symbol} id={`iw-hc-${c.symbol}`} label={`${colToken(c.symbol) ?? c.symbol} counted at (of value)`} suffix="%" value={c.haircutPct} onChange={v => set({ collateral: eco.collateral.map(x => (x.symbol === c.symbol ? { ...x, haircutPct: v } : x)) })} />
                  ))}
                  <div className="field">
                    <label htmlFor="iw-default">On a default, holders get</label>
                    <select id="iw-default" value={eco.defaultRule} onChange={e => set({ defaultRule: e.target.value as DefaultRule })}>
                      <option value="cap-at-owed">What they're owed; the rest back to you</option>
                      <option value="all-to-holders">Everything in escrow</option>
                    </select>
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
                <dt>You commit to</dt>
                <dd>
                  <ul className="iw-list">
                    <li>Lock {eco.collateral.map(c => colToken(c.symbol) ?? c.symbol).join(' + ')} worth at least {eco.collateralRatioPct}% of what's sold{remote ? ', on Robinhood Chain' : ''}, until the last payment.</li>
                    <li>Fund each payment within {dur(t.lag)} of its observation; a {dur(t.grace)} grace period follows.</li>
                    <li>If a payment is still missing, holders take {eco.defaultRule === 'cap-at-owed' ? "what they're owed" : 'everything in escrow'} from the collateral.</li>
                  </ul>
                </dd>
              </dl>
              {built ? <IssuePanel key={JSON.stringify(preset) + p.name} doc={doc} built={built} preset={preset} compact />
                : <div className="notice err">This note doesn't compile: go back and check its terms.</div>}
            </>
          )}

          <div className="iw-nav">
            {step > 0 && <button className="btn" onClick={() => setStep(s => s - 1)}><ArrowLeft className="i" />Back</button>}
            {step < 4 && <button className="btn primary" disabled={!canNext} onClick={() => setStep(s => s + 1)}>Continue: {STEPS[step + 1]}<ArrowRight className="i" /></button>}
            {step === 4 && <button className="btn" onClick={() => nav(`/issue/advanced?product=${kind}`)}><Workflow className="i" />Open in the studio</button>}
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
