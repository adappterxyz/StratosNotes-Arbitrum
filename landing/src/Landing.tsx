import { useCallback, useEffect, useRef, useState } from 'react';
import './notes.css';
import Carousel from './Carousel';
import Stage from './Stage';
import ExplorerPanel from './ExplorerPanel';
import { DEFAULT_START, type ExplorerStart } from './explorer/start';
import proofJson from './proof.json';

const APP_URL = '/app/';
const STRATOS_URL = 'https://stratoslab.xyz';
const REPO_URL = 'https://github.com/adappterxyz/StratosNotes-Arbitrum';

// Written by scripts/landing-proof.ts from deployments/*.json and docs/evidence.json: no typed-in numbers.
type Deployment = { key: string; name: string; explorer: string } & (
  | { deployed: false }
  | { deployed: true; engine: string; lens: string; faucet: string | null; forwarder: string; block: number; tokens: Record<string, string> }
);
interface Run {
  chain: string; note: string; title: string; reporter: 'cre' | 'fallback';
  events: Array<{ what: string; detail: string; tx: string; gas?: string }>;
  paid: Array<{ holder: string; units: string; paid: string }>;
}
const proof = proofJson as unknown as { generatedAt: string; deployments: Deployment[]; runs: Run[] };
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** A one-word label for a proof step. */
function stepLabel(what: string) {
  if (/collateral/i.test(what)) return 'Collateral';
  if (/subscribes/i.test(what)) return 'Subscribe';
  if (/strike/i.test(what)) return 'Strike';
  if (/observes/i.test(what)) return 'Observe';
  if (/funds/i.test(what)) return 'Funded';
  if (/pays/i.test(what)) return 'Paid';
  return what.split(' ').slice(-1)[0];
}

/** The wordmark: lowercase, with the dot as the one blue mark. */
export function Wordmark({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return <span className={`wordmark ${size}`} aria-label="notes.markets">notes<i>.</i>markets</span>;
}

export default function Landing() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  // The full explorer opens on request only (a card, the "Try a note" buttons, or a #explore link).
  const [explorer, setExplorer] = useState<ExplorerStart | null>(() =>
    typeof window !== 'undefined' && window.location.hash === '#explore' ? DEFAULT_START : null);
  const openExplorer = useCallback((s: ExplorerStart = DEFAULT_START) => { setMenu(false); setExplorer(s); }, []);
  const closeExplorer = useCallback(() => {
    setExplorer(null);
    if (window.location.hash === '#explore') history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
  useEffect(() => {
    const onHash = () => { if (window.location.hash === '#explore') setExplorer(e => e ?? DEFAULT_START); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Nav state and gentle reveals; the page is complete without them.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const header = root.querySelector('header.nav');
    const onScroll = () => header?.classList.toggle('scrolled', window.scrollY > 20);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    root.classList.add('js');
    const els = [...root.querySelectorAll<HTMLElement>('[data-reveal]')];
    const io = new IntersectionObserver(entries => entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: 0.1 });
    els.forEach(el => io.observe(el));
    const all = window.setTimeout(() => els.forEach(el => el.classList.add('in')), 1800);
    return () => { window.removeEventListener('scroll', onScroll); io.disconnect(); clearTimeout(all); root.classList.remove('js'); };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  const live = proof.deployments.filter((d): d is Extract<Deployment, { deployed: true }> => d.deployed);
  const links = [['#how', 'How it works'], ['#notes', 'What notes do'], ['#arbitrum', 'Why Arbitrum'], ['#proof', 'Proof']];

  return (
    <div className="sn-root" ref={rootRef}>
      <header className={`nav${menu ? ' open' : ''}`}>
        <div className="nav-inner">
          <a className="brand" href="#top" aria-label="notes.markets home"><Wordmark /></a>
          <nav className="nav-links" aria-label="Sections">
            {links.map(([h, t]) => <a key={h} href={h}>{t}</a>)}
          </nav>
          <div className="nav-cta">
            <button type="button" className="btn btn-ghost hide-sm" onClick={() => openExplorer()}>Try a note</button>
            <a href={APP_URL} className="btn btn-primary">Open the app</a>
            <button type="button" className="nav-menu" aria-label={menu ? 'Close menu' : 'Open menu'} aria-expanded={menu} aria-controls="nav-sheet" onClick={() => setMenu(m => !m)}>
              <span /><span /><span />
            </button>
          </div>
        </div>
        <div id="nav-sheet" className="nav-sheet" hidden={!menu}>
          {links.map(([h, t]) => <a key={h} href={h} onClick={() => setMenu(false)}>{t}</a>)}
          <button type="button" className="btn btn-ghost" onClick={() => openExplorer()}>Try a note</button>
        </div>
      </header>

      <main id="top">
        <Stage onTry={() => openExplorer()} />

        <section id="notes" className="notes-sec">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">What a note can do</span>
              <h2>Six things a note can do.</h2>
            </div>
          </div>
          <Carousel onOpen={openExplorer} />
          <div className="wrap">
            <div className="try-row">
              <button type="button" className="btn btn-ghost" onClick={() => openExplorer()}>Try a note yourself</button>
            </div>
          </div>
        </section>

        <section id="arbitrum">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Why Arbitrum</span>
              <h2>Notes run on Arbitrum. The stocks stay on Robinhood Chain.</h2>
              <p>Stock collateral and delivery stay on Robinhood Chain, where the stocks live, coordinated by Chainlink CCIP and CRE. That cross-chain link is coming next.</p>
            </div>
            <div className="cards3">
              <div className="card" data-reveal>
                <div className="card-logo"><img src="/logos/arbitrum.svg" alt="" height={26} />Arbitrum Sepolia</div>
                <span className="tag">Where notes run · testnet 421614</span>
                <p>Issue, subscribe, observe and pay: every note's lifecycle, on stocks or crypto.</p>
              </div>
              <div className="card" data-reveal>
                <div className="card-logo"><img src="/logos/robinhood-chain.svg" alt="" height={24} />Robinhood Chain</div>
                <span className="tag">Asset chain · testnet 46630</span>
                <p>Where the stock tokens live: TSLA and AMZN pledged as collateral or delivered at maturity.</p>
              </div>
              <div className="card" data-reveal>
                <div className="card-logo"><img src="/logos/chainlink.svg" alt="Chainlink" height={20} /></div>
                <span className="tag">Prices and automation</span>
                <p>Prices for ETH, BTC, SOL, TSLA, NVDA, AAPL, AMZN and SPY, checked on-chain. CCIP links the two chains (coming next).</p>
              </div>
            </div>
          </div>
        </section>

        <section id="proof">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Proof</span>
              <h2>Two notes, start to finish, on testnet.</h2>
              <p>Every step is a transaction. Every price came from Chainlink CRE.</p>
            </div>
            <div className="runs">
              {proof.runs.map(r => {
                const dep = proof.deployments.find(d => d.key === r.chain);
                const ex = dep?.explorer;
                const [title, outcome] = r.title.split(': ');
                return (
                  <article key={r.note} className="run-card" data-reveal>
                    <h3>{title.replace(/^Demo /, '')}</h3>
                    {outcome && <p className="run-outcome">{outcome}</p>}
                    <ol className="run-steps">
                      {r.events.map((e, i) => {
                        const k = stepLabel(e.what);
                        const cl = e.what.startsWith('Chainlink');
                        const body = <><span className="run-k">{k}</span><span className="mono">{e.tx.slice(0, 8)}</span></>;
                        return (
                          <li key={e.tx + i} className={cl ? 'cl' : undefined} title={`${e.what}: ${e.detail}`}>
                            {ex ? <a href={`${ex}/tx/${e.tx}`} target="_blank" rel="noopener">{body}</a> : body}
                          </li>
                        );
                      })}
                    </ol>
                    {r.paid.length > 0 && (
                      <p className="paid">{r.paid.map(p => <span key={p.holder}>{p.units} units → <b className="up">{p.paid}</b></span>)}</p>
                    )}
                    {dep && dep.deployed && <a className="run-contract mono" href={`${ex}/address/${dep.engine}`} target="_blank" rel="noopener">engine {short(dep.engine)}</a>}
                  </article>
                );
              })}
            </div>
            {live.length === 0 && <p className="muted">Nothing is deployed yet.</p>}
          </div>
        </section>

        <section id="cta">
          <div className="wrap">
            <div className="cta-final" data-reveal>
              <h2>Try it on testnet.</h2>
              <div className="hero-cta">
                <a href={APP_URL} className="btn btn-primary btn-lg">Open the app</a>
                <button type="button" className="btn btn-ghost btn-lg" onClick={() => openExplorer()}>Try a note</button>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="wrap foot-inner">
          <Wordmark />
          <div className="foot-links">
            <a href={APP_URL}>App</a>
            <a href={REPO_URL} target="_blank" rel="noopener">GitHub</a>
            <a href={STRATOS_URL} target="_blank" rel="noopener">stratoslab.xyz</a>
          </div>
          <small className="by"><img src="/logos/stratos-mark.png" alt="" width={16} height={16} />by Stratos Lab · Testnet only · Trademarks belong to their owners; no endorsement implied.</small>
        </div>
      </footer>
      {explorer && <ExplorerPanel start={explorer} onClose={closeExplorer} />}
    </div>
  );
}
